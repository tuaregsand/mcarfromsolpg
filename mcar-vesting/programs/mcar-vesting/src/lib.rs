use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};
use solana_program::program::invoke_signed;
use solana_program::system_instruction;
// Removed optional Clockwork integration to avoid dependency conflicts
// use crate::program::McarVesting; // Removed unused import

declare_id!("8UDAtqgE7sK6a8QXhftxEumwoSegJhPwo8R41dZKrjz3"); // Replace with your actual program ID

// Constants for vesting schedule (example: 10% daily)
// const DAILY_UNLOCK_PERCENTAGE: u64 = 10; // Removed, using PRD logic
const SECONDS_IN_DAY: i64 = 86400; // As per PRD

// Scaling factor for reflection index (1e12)
const REFLECTION_INDEX_SCALE: u128 = 1_000_000_000_000;

#[program]
pub mod mcar_vesting {
    use super::*;

    /// Initializes the global configuration and vaults.
    /// Should be called once by the admin.
    pub fn initialize(
        ctx: Context<Initialize>,
        // Removed initial_unlock_percent
        // Removed vesting_period_days
        yield_rate_bps: u16,      // Annual yield rate in basis points
    ) -> Result<()> {
        // Removed checks for initial_unlock_percent and vesting_period_days

        // Prevent re-initialization
        let cfg = &ctx.accounts.config;
        require!(cfg.admin == Pubkey::default(), ProgramError::AlreadyInitialized);
        // Create the SOL treasury PDA via CPI
        let treasury_bump = ctx.bumps.sol_treasury;
        let treasury_seeds = &[
            b"sol_treasury".as_ref(),
            &[treasury_bump]
        ];
        let signer_seeds = &[&treasury_seeds[..]];

        invoke_signed(
            &system_instruction::create_account(
                ctx.accounts.admin.key, // From/Payer
                ctx.accounts.sol_treasury.key, // To/New account
                Rent::get()?.minimum_balance(0), // Lamports for rent (system account needs 0 data space)
                0, // Space
                &System::id(), // Owner (System Program)
            ),
            &[
                ctx.accounts.admin.to_account_info(),
                ctx.accounts.sol_treasury.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer_seeds,
        )?;

        msg!("SOL Treasury PDA created: {}", ctx.accounts.sol_treasury.key());

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key(); // Set admin from signer
        config.token_mint = ctx.accounts.token_mint.key();
        config.vault_authority_bump = ctx.bumps.vault_authority;
        config.sol_treasury_bump = treasury_bump; // Use the bump derived earlier
        config.staked_vault = ctx.accounts.staked_vault.key();
        config.reward_vault = ctx.accounts.reward_vault.key(); // Store reward vault key
        config.total_staked = 0;
        config.reflection_index = 0; // Starts at 0
        // Removed initial_unlock_percent assignment
        // Removed vesting_period_seconds assignment
        config.yield_rate_bps = yield_rate_bps;
        config.distribution_cursor = 0; // Initialize distribution cursor

        Ok(())
    }

    /// Creates a UserStake account for a user, allowing them to participate.
    /// Necessary before staking or claiming reflections for the first time.
    pub fn register_user(ctx: Context<RegisterUser>) -> Result<()> {
        let user_stake = &mut ctx.accounts.user_stake;
        let config = &ctx.accounts.config;
        user_stake.owner = ctx.accounts.user.key();
        user_stake.staked_amount = 0;
        // Removed vesting_basis_locked_amount initialization
        user_stake.start_timestamp = 0;
        user_stake.last_claimed_index = config.reflection_index; // Initialize to current index
        user_stake.unclaimed_yield = 0;
        user_stake.last_yield_claim_time = Clock::get()?.unix_timestamp; // Start yield accrual now
        Ok(())
    }

    /// Admin function to initialize stake for a presale user.
    pub fn admin_initialize_presale_stake(
        ctx: Context<AdminInitializePresaleStake>,
        // user_pubkey parameter is implicitly handled by the user_stake account constraint
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, ProgramError::InvalidAmount);

        let config = &mut ctx.accounts.config;
        let user_stake = &mut ctx.accounts.user_stake;
        let clock = Clock::get()?;

        // Initialize UserStake fields
        user_stake.owner = ctx.accounts.user.key(); // Set owner from the user account provided
        user_stake.staked_amount = amount;
        user_stake.start_timestamp = clock.unix_timestamp; // Set vesting start time
        user_stake.last_claimed_index = config.reflection_index; // Initialize to current index
        user_stake.unclaimed_yield = 0;
        user_stake.last_yield_claim_time = clock.unix_timestamp; // Start yield accrual now

        // Transfer tokens from source_token_account to staked_vault
        let cpi_accounts = token_interface::TransferChecked {
            from: ctx.accounts.source_token_account.to_account_info(),
            mint: ctx.accounts.token_mint.to_account_info(),
            to: ctx.accounts.staked_vault.to_account_info(),
            authority: ctx.accounts.admin.to_account_info(), // Admin signs the transfer
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.token_mint.decimals)?;

        // Update global state
        config.total_staked = config
            .total_staked
            .checked_add(amount)
            .ok_or(ProgramError::CalculationOverflow)?;

        Ok(())
    }

    /// Deposits SOL into the treasury and updates the global reflection index.
    /// Called by admin/bot after swapping fee tokens to SOL.
    /// Assumes the SOL has already been transferred to the sol_treasury PDA.
    pub fn deposit_reflection_funds(
        ctx: Context<DepositReflectionFunds>,
        sol_amount: u64,
        total_supply: u64, // Added total_supply parameter as per PRD
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        // Admin check is now handled by the signer constraint in DepositReflectionFunds context

        require!(total_supply > 0, ProgramError::InvalidTotalSupply);

        msg!("Calculating index increase: sol_amount = {}, scale = {}, total_supply = {}", sol_amount, REFLECTION_INDEX_SCALE, total_supply);

        // Use total_supply for index calculation as per PRD
        let index_increase = (sol_amount as u128)
            .checked_mul(REFLECTION_INDEX_SCALE)
            .and_then(|x| x.checked_div(total_supply as u128))
            .ok_or(ProgramError::CalculationOverflow)?;

        msg!("Calculated index_increase: {}", index_increase);
        msg!("Old reflection_index: {}", config.reflection_index);

        config.reflection_index = config
            .reflection_index
            .checked_add(index_increase)
            .ok_or(ProgramError::CalculationOverflow)?;

        msg!(
            "Deposited {} SOL lamports. New reflection index: {}",
            sol_amount,
            config.reflection_index
        );
        Ok(())
    }
   /// Admin-only instruction to withdraw SOL from the treasury PDA (e.g., for test setups or emergency).
   pub fn admin_withdraw_sol(ctx: Context<AdminWithdrawSol>, amount: u64) -> Result<()> {
       // Ensure treasury has enough lamports to withdraw
       let treasury_lamports = ctx.accounts.sol_treasury.lamports();
       require!(
           treasury_lamports >= amount,
           ProgramError::InsufficientReflectionPool
       );
       // Transfer lamports from treasury PDA to admin
       let seeds = &[b"sol_treasury".as_ref(), &[ctx.accounts.config.sol_treasury_bump]];
       let signer_seeds = &[&seeds[..]];
       invoke_signed(
           &system_instruction::transfer(
               ctx.accounts.sol_treasury.key,
               ctx.accounts.admin.key,
               amount,
           ),
           &[
               ctx.accounts.sol_treasury.to_account_info(),
               ctx.accounts.admin.to_account_info(),
               ctx.accounts.system_program.to_account_info(),
           ],
           signer_seeds,
       )?;
       Ok(())
   }

    /// Stakes MCOIN tokens, initiating or resetting the 7-day unlock period.
    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, ProgramError::InvalidAmount);

        let config = &mut ctx.accounts.config;
        let user_stake = &mut ctx.accounts.user_stake;
        let clock = Clock::get()?;

        // Calculate and add yield accrued *before* this new stake changes the principal
        let accrued_yield = user_stake.calculate_yield(config, clock.unix_timestamp)?;
        user_stake.unclaimed_yield = user_stake
            .unclaimed_yield
            .checked_add(accrued_yield)
            .ok_or(ProgramError::CalculationOverflow)?;
        // Reset yield timer regardless
        // last_yield_claim_time is now set *after* user_stake updates below

        // Transfer tokens from user to staked_vault
        let cpi_accounts = token_interface::TransferChecked {
            from: ctx.accounts.user_token_account.to_account_info(),
            mint: ctx.accounts.token_mint.to_account_info(),
            to: ctx.accounts.staked_vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(), // User signs the transfer
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token_interface::transfer_checked(cpi_ctx, amount, ctx.accounts.token_mint.decimals)?;

        // Update global state
        config.total_staked = config
            .total_staked
            .checked_add(amount)
            .ok_or(ProgramError::CalculationOverflow)?;

        // Remove calculation of initial locked amount based on percentage

        // Update user stake details
        user_stake.staked_amount = user_stake
            .staked_amount
            .checked_add(amount)
            .ok_or(ProgramError::CalculationOverflow)?;
        // Removed update to vesting_basis_locked_amount

        // Always reset start_timestamp and last_yield_claim_time on any stake action as per PRD
        user_stake.start_timestamp = clock.unix_timestamp;
        user_stake.last_yield_claim_time = clock.unix_timestamp;

        Ok(())
    }

    /// Unstakes (withdraws) tokens that have become unlocked according to the 7-day schedule.
    pub fn unstake(ctx: Context<Unstake>, amount_to_withdraw: u64) -> Result<()> {
        // Require the requested withdraw amount to be positive *before* calculating actual
        require!(amount_to_withdraw > 0, ProgramError::InvalidAmount);

        let user_stake = &mut ctx.accounts.user_stake;
        let clock = Clock::get()?;

        // Calculate currently withdrawable amount based on 7-day vesting progress
        let available_to_withdraw = user_stake.calculate_unlocked_amount(clock.unix_timestamp)?;

        // Check if requested amount exceeds available unlocked amount
        require!(
            amount_to_withdraw <= available_to_withdraw,
            ProgramError::AmountExceedsUnlocked
        );

        // Sanity check: Ensure withdrawing amount doesn't exceed current stake
        // (Though available_to_withdraw should already be capped by staked_amount)
        require!(amount_to_withdraw <= user_stake.staked_amount, ProgramError::CalculationOverflow);

        // Transfer tokens from staked_vault back to user
        let seeds = &[
            b"vault_auth".as_ref(),
            &[ctx.accounts.config.vault_authority_bump], // Access bump via config account in context
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = token_interface::TransferChecked {
            from: ctx.accounts.staked_vault.to_account_info(),
            mint: ctx.accounts.token_mint.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token_interface::transfer_checked(
            cpi_ctx,
            amount_to_withdraw, // Use the validated amount directly
            ctx.accounts.token_mint.decimals,
        )?;

        // Update global state
        let config_mut = &mut ctx.accounts.config; // Get mutable ref to config for update
        config_mut.total_staked = config_mut
            .total_staked
            .checked_sub(amount_to_withdraw)
            .ok_or(ProgramError::CalculationOverflow)?;

        // Update user stake details
        user_stake.staked_amount = user_stake
            .staked_amount
            .checked_sub(amount_to_withdraw)
            .ok_or(ProgramError::CalculationOverflow)?;

        // If fully unstaked, reset vesting start time
        if user_stake.staked_amount == 0 {
            user_stake.start_timestamp = 0;
            // Removed vesting_basis_locked_amount reset
        }

        Ok(())
    }

    /// Claims accumulated staking yield.
    pub fn claim_yield(ctx: Context<ClaimYield>) -> Result<()> {
        let config = &ctx.accounts.config;
        let user_stake = &mut ctx.accounts.user_stake;
        let clock = Clock::get()?;

        // Calculate and update yield first
        let accrued_yield = user_stake.calculate_yield(config, clock.unix_timestamp)?;
        user_stake.unclaimed_yield = user_stake
            .unclaimed_yield
            .checked_add(accrued_yield)
            .ok_or(ProgramError::CalculationOverflow)?;
        // Update last claim time *after* potential yield transfer

        let yield_to_claim = user_stake.unclaimed_yield;
        require!(yield_to_claim > 0, ProgramError::NoYieldToClaim);

        // Transfer yield from reward_vault to user
        let seeds = &[
            b"vault_auth".as_ref(),
            &[config.vault_authority_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = token_interface::TransferChecked {
            from: ctx.accounts.reward_vault.to_account_info(),
            mint: ctx.accounts.token_mint.to_account_info(), // Assuming yield is in MCOIN
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        token_interface::transfer_checked(
            cpi_ctx,
            yield_to_claim,
            ctx.accounts.token_mint.decimals,
        )?;

        // Reset unclaimed yield and update last claim time
        user_stake.unclaimed_yield = 0;
        user_stake.last_yield_claim_time = clock.unix_timestamp;

        Ok(())
    }

    /// Claims accumulated reflection rewards (in SOL).
    pub fn claim_reflections(ctx: Context<ClaimReflections>) -> Result<()> {
        let config = &ctx.accounts.config;
        let user_stake = &mut ctx.accounts.user_stake;

        // Reflection calculation now only based on staked_amount as per PRD
        let reflection_basis_balance = user_stake.staked_amount;

        if reflection_basis_balance == 0 {
            // Update index anyway to prevent re-check, even if no reward
            user_stake.last_claimed_index = config.reflection_index;
            msg!("User has no staked tokens, skipping reflection payout but updating index.");
            // Return Ok(()) because holding 0 tokens isn't an error state for claiming.
            // No need to return NoTokensHeld error here.
             return Ok(());
        }

        // Calculate pending reflections
        let global_index = config.reflection_index;
        let user_last_index = user_stake.last_claimed_index;

        // It's possible global_index == user_last_index if no reflections deposited or user claimed very recently
        if global_index <= user_last_index {
             msg!("No new reflections accumulated since last claim (Global: {}, User: {}).", global_index, user_last_index);
             // Update index just in case it somehow decreased (highly unlikely) or stayed same
             user_stake.last_claimed_index = global_index;
             // Return specific error as per PRD requirements section 6
             return Err(ProgramError::NoReflectionsAccumulated.into());
        }

        let index_diff = global_index
            .checked_sub(user_last_index)
            .ok_or(ProgramError::CalculationOverflow)?; // Should not happen if check above passes

        // Calculate reward: reward = index_diff * reflection_basis_balance / scale
        let pending_reward_scaled = (index_diff as u128)
            .checked_mul(reflection_basis_balance as u128)
            .ok_or(ProgramError::CalculationOverflow)?;

        let pending_reward_lamports = pending_reward_scaled
            .checked_div(REFLECTION_INDEX_SCALE)
            .ok_or(ProgramError::CalculationOverflow)? as u64;

        // Check reward > 0 as per PRD requirement
        // If reward calculates to 0 (e.g., due to very small stake or index diff), treat as no reflections accumulated.
        require!(pending_reward_lamports > 0, ProgramError::NoReflectionsAccumulated);

        // Check treasury balance
        let treasury_lamports = ctx.accounts.sol_treasury.lamports();
        require!(
            treasury_lamports >= pending_reward_lamports,
            ProgramError::InsufficientReflectionPool
        );

        // --- Add Logging Here ---
        msg!("Attempting SOL transfer:");
        msg!("  Treasury PDA: {}", ctx.accounts.sol_treasury.key());
        msg!("  User recipient: {}", ctx.accounts.user.key());
        msg!("  Amount (lamports): {}", pending_reward_lamports);
        msg!("  Treasury current balance: {}", treasury_lamports);
        msg!("  Expected bump: {}", config.sol_treasury_bump);
        // --- End Logging ---

        // Transfer SOL from treasury PDA to user
        let seeds = &[b"sol_treasury".as_ref(), &[config.sol_treasury_bump]];
        let signer_seeds = &[&seeds[..]];

        invoke_signed(
            &system_instruction::transfer(
                ctx.accounts.sol_treasury.key,
                ctx.accounts.user.key,
                pending_reward_lamports,
            ),
            &[
                ctx.accounts.sol_treasury.to_account_info(),
                ctx.accounts.user.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer_seeds,
        )?;

        // Update user's last claimed index
        user_stake.last_claimed_index = global_index;

        Ok(())
    }

}

// --- Context for Admin Withdraw SOL ---
#[derive(Accounts)]
#[instruction(amount: u64)]
pub struct AdminWithdrawSol<'info> {
    /// Admin signer authorized in config
    #[account(mut,
        constraint = config.admin == admin.key() @ ProgramError::Unauthorized
    )]
    pub admin: Signer<'info>,
    /// Global config PDA
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, GlobalConfig>,
    /// CHECK: This is the SOL treasury PDA. The necessary checks (mutability,
    /// seeds, bump) are performed by the #[account(...)] macro constraints.
    /// We are manually transferring lamports from it.
    #[account(mut, seeds = [b"sol_treasury"], bump = config.sol_treasury_bump)]
    pub sol_treasury: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}
// --- Accounts Structures ---

#[account]
#[derive(Default)]
pub struct GlobalConfig {
    pub admin: Pubkey,            // 32
    pub token_mint: Pubkey,       // 32
    pub vault_authority_bump: u8, // 1
    pub sol_treasury_bump: u8,    // 1
    pub staked_vault: Pubkey,     // 32
    pub reward_vault: Pubkey,     // 32
    pub total_staked: u64,        // 8
    pub reflection_index: u128,   // 16
    pub yield_rate_bps: u16,      // 2
    pub distribution_cursor: u64, // New field to track batch position
} // Total: 32*4 + 1*2 + 8 + 16 + 2 = 128 + 2 + 8 + 16 + 2 = 156 bytes

#[account]
#[derive(Default)]
pub struct UserStake {
    pub owner: Pubkey,              // 32
    pub staked_amount: u64,       // 8
    // Removed vesting_basis_locked_amount: u64,
    pub start_timestamp: i64,   // 8 - Timestamp of the last stake, used for vesting start
    pub last_claimed_index: u128, // 16 - Global reflection index at last reflections claim
    pub unclaimed_yield: u64,     // 8 - Accumulated staking yield (in token units)
    pub last_yield_claim_time: i64, // 8 - Timestamp of last yield claim/update
} // Total: 32 + 8 + 8 + 16 + 8 + 8 = 80 bytes

impl UserStake {
    /// Calculates the amount currently available for withdrawal based on the 7-day unlock schedule.
    pub fn calculate_unlocked_amount(
        &self,
        // Removed config: &GlobalConfig, - no longer needed
        current_timestamp: i64,
    ) -> Result<u64> {
        // PRD: "For the 7 days following this start_timestamp, 10% of the *total currently staked amount* becomes available..."
        // If start_timestamp is 0 (no stake yet or fully unstaked), nothing is available.
        if self.start_timestamp == 0 || self.staked_amount == 0 {
            return Ok(0); // Nothing staked or vesting not started, nothing to unlock
        }

        let seconds_elapsed = current_timestamp
            .checked_sub(self.start_timestamp)
            .unwrap_or(0); // Treat time before start as 0 elapsed

        // If time somehow went backwards, no time elapsed for unlock
        if seconds_elapsed < 0 {
             return Ok(0);
        }

        let days_elapsed = seconds_elapsed / SECONDS_IN_DAY; // Integer division gives full days passed

        // Calculate unlocked percentage: 10% per full day, capped at 100% after 7 days (>= 7)
        let unlocked_percentage = if days_elapsed >= 7 {
            100u64 // Use u64 directly
        } else {
            // days_elapsed is i64, cast to u64 for multiplication
            (days_elapsed as u64).checked_mul(10).unwrap_or(0) // Calculate 10% per day
        };

        // Calculate max withdrawable amount using u128 intermediate calculation
        let max_withdrawable = (self.staked_amount as u128)
            .checked_mul(unlocked_percentage as u128)
            .and_then(|x| x.checked_div(100))
            .ok_or(ProgramError::CalculationOverflow)? as u64;

        // Ensure we don't return more than actually staked (shouldn't happen with %)
        Ok(max_withdrawable.min(self.staked_amount))
    }

    /// Calculates yield accrued since the last update.
    pub fn calculate_yield(
        &self,
        config: &GlobalConfig,
        current_timestamp: i64,
    ) -> Result<u64> {
        if self.staked_amount == 0 || config.yield_rate_bps == 0 {
            return Ok(0);
        }

        let time_elapsed = current_timestamp
            .checked_sub(self.last_yield_claim_time)
            .unwrap_or(0); // Use 0 if current_timestamp < last_claim

        if time_elapsed <= 0 {
            return Ok(0);
        }

        // Simple APR calculation: yield = principal * rate * time
        // Use u128 for intermediate calculation
        const SECONDS_IN_YEAR: u128 = 365 * 24 * 60 * 60; // Use const

        let yield_amount = (self.staked_amount as u128)
            .checked_mul(config.yield_rate_bps as u128)
            .and_then(|x| x.checked_mul(time_elapsed as u128))
            .and_then(|x| x.checked_div(10000u128)) // Apply basis points
            .and_then(|x| x.checked_div(SECONDS_IN_YEAR))
            .ok_or(ProgramError::CalculationOverflow)?;

        Ok(yield_amount as u64)
    }
}

// --- Instruction Contexts ---

#[derive(Accounts)]
#[instruction(yield_rate_bps: u16)] // Removed unused params from instruction macro
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>, // Changed payer to admin and made it signer

    #[account(
        init_if_needed,
        seeds = [b"config"],
        bump,
        payer = admin, // Admin pays for initialization
        space = 8 + 164 // 8 discriminator + 164 struct size
    )]
    pub config: Box<Account<'info, GlobalConfig>>,

    /// CHECK: Just a PDA used as vault authority
    #[account(
        seeds = [b"vault_auth"],
        bump
    )]
    pub vault_authority: AccountInfo<'info>,

    /// CHECK: SOL treasury PDA - To be created via CPI
    #[account(
        mut, // Mutable because we will fund it via CPI
        seeds = [b"sol_treasury"],
        bump
    )]
    pub sol_treasury: AccountInfo<'info>,

    pub token_mint: InterfaceAccount<'info, Mint>, // Still needed to store in config

    // Vaults must be created externally and owned by vault_authority PDA
    #[account(
        token::mint = token_mint,
        token::authority = vault_authority,
        mut // Needs mut to store its key in config
    )]
    pub staked_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        token::mint = token_mint,
        token::authority = vault_authority,
        mut // Needs mut to store its key in config
    )]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    // Rent is implicitly checked by init
    // pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RegisterUser<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init,
        seeds = [b"user", user.key().as_ref()],
        bump,
        payer = user,
        space = 8 + 80 // 8 discriminator + 80 struct size
    )]
    pub user_stake: Account<'info, UserStake>,
    // Need config to initialize last_claimed_index
    #[account(seeds = [b"config"], bump)] // Removed mut constraint
    pub config: Account<'info, GlobalConfig>,
    pub system_program: Program<'info, System>,
    // Rent is implicitly checked by init
    // pub rent: Sysvar<'info, Rent>,
}

// --- Context for Admin Initialize Presale Stake ---
#[derive(Accounts)]
#[instruction(amount: u64)]
pub struct AdminInitializePresaleStake<'info> {
    #[account(mut)]
    pub admin: Signer<'info>, // Admin must sign this action

    #[account(
        init_if_needed, // Create UserStake if it doesn't exist for the user
        seeds = [b"user", user.key().as_ref()],
        bump,
        payer = admin, // Admin pays for PDA creation if needed
        space = 8 + 80 // Updated size: 8 + sizeof(UserStake)
    )]
    pub user_stake: Account<'info, UserStake>,

    /// CHECK: The user account whose stake is being initialized. No signature required.
    /// The user PDA is derived from this key, ensuring correctness.
    pub user: AccountInfo<'info>,

    #[account(mut,
        seeds = [b"config"],
        bump,
        // Ensure admin signer matches the config admin
        constraint = config.admin == admin.key() @ ProgramError::Unauthorized
    )]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(mut,
        // Constraint to ensure source account is owned by the admin signer
        constraint = source_token_account.owner == admin.key() @ ProgramError::Unauthorized,
        token::mint = config.token_mint
    )]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut,
        // Use address constraint to ensure it's the correct vault from config
        address = config.staked_vault @ ProgramError::VaultMismatch
    )]
    pub staked_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(address = config.token_mint)] // Ensure mint matches config
    pub token_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    // Rent needed for init_if_needed
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositReflectionFunds<'info> {
    // Admin must sign to deposit funds
    pub admin: Signer<'info>,
    #[account(mut,
        seeds = [b"config"],
        bump,
        // Ensure admin signer matches the config admin
        constraint = config.admin == admin.key() @ ProgramError::Unauthorized
    )]
    pub config: Account<'info, GlobalConfig>,
    /// CHECK: PDA holding SOL for reflections. Must have SOL balance transferred externally.
    #[account(mut, seeds = [b"sol_treasury"], bump = config.sol_treasury_bump)]
    pub sol_treasury: AccountInfo<'info>,
    // No longer need SystemProgram here unless doing CPI transfer *in* this instruction
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [b"user", user.key().as_ref()],
        bump,
        constraint = user_stake.owner == user.key() @ ProgramError::UserAccountMismatch
    )]
    pub user_stake: Account<'info, UserStake>,
    #[account(mut,
        token::mint = config.token_mint,
        token::authority = user, // User must own the source token account
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut,
        address = config.staked_vault @ ProgramError::VaultMismatch
    )]
    pub staked_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Box<Account<'info, GlobalConfig>>,
    #[account(address = config.token_mint)] // Ensure mint matches config
    pub token_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [b"user", user.key().as_ref()],
        bump,
        constraint = user_stake.owner == user.key() @ ProgramError::UserAccountMismatch
    )]
    pub user_stake: Account<'info, UserStake>,
    #[account(mut,
        token::mint = config.token_mint,
        token::authority = user, // Withdraw to user's account
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: PDA authority, signs the transfer from vault.
    #[account(
        seeds = [b"vault_auth"],
        bump = config.vault_authority_bump
    )]
    pub vault_authority: AccountInfo<'info>,
    #[account(mut,
        address = config.staked_vault @ ProgramError::VaultMismatch
    )]
    pub staked_vault: InterfaceAccount<'info, TokenAccount>,
    // Config needed for vault authority bump, token mint address, and total_staked update
    #[account(mut, seeds = [b"config"], bump)] // Make config mutable for total_staked update
    pub config: Box<Account<'info, GlobalConfig>>,
    #[account(address = config.token_mint)]
    pub token_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClaimYield<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [b"user", user.key().as_ref()],
        bump,
        constraint = user_stake.owner == user.key() @ ProgramError::UserAccountMismatch
    )]
    pub user_stake: Account<'info, UserStake>,
    #[account(mut,
        token::mint = config.token_mint, // Assuming MCOIN yield
        token::authority = user,
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>, // Destination for yield
    /// CHECK: PDA authority, signs the transfer from reward vault.
    #[account(
        seeds = [b"vault_auth"],
        bump = config.vault_authority_bump
    )]
    pub vault_authority: AccountInfo<'info>,
    #[account(mut,
        address = config.reward_vault @ ProgramError::VaultMismatch
    )]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>, // Source of yield tokens
    #[account(seeds = [b"config"], bump)] // Config doesn't need mut here
    pub config: Box<Account<'info, GlobalConfig>>,
    #[account(address = config.token_mint)]
    pub token_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClaimReflections<'info> {
    #[account(mut)]
    pub user: Signer<'info>, // Also the recipient of SOL
    #[account(
        mut,
        seeds = [b"user", user.key().as_ref()],
        bump,
        constraint = user_stake.owner == user.key() @ ProgramError::UserAccountMismatch
    )]
    pub user_stake: Account<'info, UserStake>,
    /// CHECK: PDA SOL treasury, signs the SOL transfer.
    #[account(mut,
        seeds = [b"sol_treasury"],
        bump = config.sol_treasury_bump
    )]
    pub sol_treasury: AccountInfo<'info>,
    #[account(seeds = [b"config"], bump)] // Config doesn't need mut here
    pub config: Box<Account<'info, GlobalConfig>>,
    pub system_program: Program<'info, System>, // Still needed for CPI transfer
}

#[cfg(feature = "clockwork")]
#[derive(Accounts)]
pub struct ScheduleReflectionDistribution<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Clockwork thread PDA
    #[account(mut)]
    pub thread: UncheckedAccount<'info>,

    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, GlobalConfig>,

    /// CHECK: SOL treasury PDA
    #[account(mut, seeds = [b"sol_treasury"], bump = config.sol_treasury_bump)]
    pub sol_treasury: UncheckedAccount<'info>,

    pub program: Program<'info, McarVesting>,
    pub system_program: Program<'info, System>,
}

#[cfg(feature = "clockwork")]
#[derive(Accounts)]
pub struct DistributeReflections<'info> {
    #[account(mut, seeds = [b"config"], bump)]
    pub config: Account<'info, GlobalConfig>,

    /// CHECK: SOL treasury PDA
    #[account(mut, seeds = [b"sol_treasury"], bump = config.sol_treasury_bump)]
    pub sol_treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,

    pub remaining_accounts: Vec<AccountInfo<'info>>,
}

// --- Custom Errors ---

#[error_code]
pub enum ProgramError {
    #[msg("Calculation resulted in overflow")]
    CalculationOverflow,
    #[msg("Obsolete: Invalid initial unlock percentage")] // Marked Obsolete
    InvalidInitialUnlock,
    #[msg("Obsolete: Invalid vesting period")] // Marked Obsolete
    InvalidVestingPeriod,
    #[msg("Invalid token amount provided (must be > 0)")] // Added detail
    InvalidAmount,
    #[msg("UserStake account owner does not match signer")]
    UserAccountMismatch,
    #[msg("Provided vault account does not match config")]
    VaultMismatch,
    #[msg("No tokens are currently available for withdrawal based on vesting schedule")] // Kept wording
    NoTokensUnlockedYet,
    #[msg("Withdrawal amount exceeds currently unlocked tokens")]
    AmountExceedsUnlocked,
    #[msg("No staking yield available to claim")]
    NoYieldToClaim,
    #[msg("User holds no staked tokens to claim reflections for")] // Kept wording
    NoTokensHeld,
    #[msg("No reflection rewards have accumulated or reward is zero")] // Kept wording
    NoReflectionsAccumulated,
    #[msg("SOL treasury balance is insufficient to pay reflections")]
    InsufficientReflectionPool,
    #[msg("Unauthorized action, signer does not match admin")] // Kept wording
    Unauthorized,
    #[msg("Total supply must be greater than zero for reflection calculation")] // New Error
    InvalidTotalSupply,
    #[msg("Contract already initialized")]
    AlreadyInitialized,
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::prelude::Pubkey;

    #[test]
    fn test_calculate_unlocked_amount() {
        let mut stake = UserStake::default();
        stake.staked_amount = 100;
        stake.start_timestamp = 0;
        // No time elapsed => 0 unlocked
        assert_eq!(stake.calculate_unlocked_amount(0).unwrap(), 0);
        // After 1 day => 10% of 100
        let one_day = SECONDS_IN_DAY;
        assert_eq!(stake.calculate_unlocked_amount(one_day).unwrap(), 10);
        // After 3 days => 30% of 100
        let three_days = 3 * SECONDS_IN_DAY;
        assert_eq!(stake.calculate_unlocked_amount(three_days).unwrap(), 30);
        // After 8 days => capped at 100% => 100
        let eight_days = 8 * SECONDS_IN_DAY;
        assert_eq!(stake.calculate_unlocked_amount(eight_days).unwrap(), 100);
    }

    #[test]
    fn test_calculate_yield() {
        let mut stake = UserStake::default();
        stake.staked_amount = 100;
        stake.last_yield_claim_time = 0;
        // Construct config with 10% APR (1000 bps)
        let config = GlobalConfig {
            admin: Pubkey::default(),
            token_mint: Pubkey::default(),
            vault_authority_bump: 0,
            sol_treasury_bump: 0,
            staked_vault: Pubkey::default(),
            reward_vault: Pubkey::default(),
            total_staked: 0,
            reflection_index: 0,
            yield_rate_bps: 1000, // 10% APR
            distribution_cursor: 0,
        };
        // One full year elapsed
        let seconds_per_year = 365u64 * 24 * 60 * 60;
        let y = stake.calculate_yield(&config, seconds_per_year as i64).unwrap();
        // 100 tokens * 10% = 10 tokens
        assert_eq!(y, 10);
        // Zero or negative elapsed => zero yield
        assert_eq!(stake.calculate_yield(&config, 0).unwrap(), 0);
    }
}
