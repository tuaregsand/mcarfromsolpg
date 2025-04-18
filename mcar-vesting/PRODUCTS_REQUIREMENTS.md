## MCar Vesting & Staking Contract - PRD

**Version:** 1.1
**Date:** 2025-04-15

**1. Introduction & Goal**

This document outlines the requirements for the Solana smart contract governing MCOIN token vesting for presale participants and staking functionalities for all MCOIN holders. The contract aims to manage token unlocks, staking rewards (in MCOIN), and Solana (SOL) reflection rewards derived from a transaction tax.

**2. Actors**

*   **Presale Buyer:** Participated in the MCOIN presale. Receives an initial airdrop and has the remainder staked automatically.
*   **Public Buyer:** Acquires MCOIN post-launch via exchanges or swaps.
*   **Wallet Holder:** Any user holding MCOIN in their wallet (includes Public Buyers and potentially Presale Buyers after unstaking).
*   **Staker:** Any user (Presale or Public) who has MCOIN actively staked in the contract.
*   **Admin:** Authorized wallet responsible for contract initialization and potentially managing presale stake setups.
*   **Off-Chain Bot:** Automated script responsible for collecting MCOIN tax, swapping to SOL, depositing SOL reflections, and distributing SOL reflections to wallet holders.

**3. Core Tokenomics**

*   **MCOIN Token:**
    *   Will utilize the **Solana Token-2022 Program**.
    *   Will implement the `TransferFeeConfig` extension to apply an on-chain transaction tax (percentage TBD).
    *   Fees collected (in MCOIN) will be sent to a designated account controlled by the Off-Chain Bot's authority.
*   **SOL Reflections:**
    *   **Source:** Originate from the MCOIN transaction tax.
    *   **Mechanism:**
        1.  Off-Chain Bot collects accumulated MCOIN tax tokens.
        2.  Bot swaps collected MCOIN for SOL (e.g., using Raydium CPMM pools via SDK).
        3.  Bot calls the `deposit_reflection_funds` instruction in this contract, providing the swapped SOL amount and the *current total supply* of MCOIN.
        4.  The contract updates a global `reflection_index`.
        5.  **Stakers:** Claim their SOL reflection share manually via `claim_reflections` based on their `staked_amount` and the index change.
        6.  **Wallet Holders:** Receive their SOL reflection share automatically via distributions performed by the Off-Chain Bot (calculation: `wallet_balance * index_change / scale`).
*   **MCOIN Staking Yield:**
    *   **Source:** A predefined pool of MCOIN held in the contract's `reward_vault`.
    *   **Mechanism:** Staked tokens accrue MCOIN yield based on a configurable annual percentage rate (APR).
    *   **Claim:** Stakers claim accrued MCOIN yield manually via `claim_yield`.
    *   **Yield Boosting:** (Future Enhancement) Possibility to add higher yield rates for longer lock commitments. Not included in V1.

**4. Vesting Mechanism (Universal 7-Day Unlock)**

*   **Applicability:** This mechanism applies universally to:
    *   The initial 70% stake created for Presale Buyers.
    *   Any subsequent voluntary stake made by Public Buyers (or Presale Buyers).
*   **Logic:**
    *   When MCOIN is staked (either initially for presale or voluntarily later), a `start_timestamp` is recorded/updated for the user's stake.
    *   For the 7 days following this `start_timestamp`, 10% of the *total currently staked amount* becomes available for unstaking *each day*.
    *   **Calculation (`calculate_unlocked_amount` internal logic):**
        *   `seconds_elapsed = max(0, current_timestamp - start_timestamp)`
        *   `days_elapsed = seconds_elapsed / SECONDS_IN_DAY` (integer division)
        *   `unlocked_percentage = min(100, days_elapsed * 10)`
        *   `max_withdrawable = (staked_amount as u128 * unlocked_percentage as u128) / 100` (use u128 intermediate for multiplication)
    *   After 7 full days (`days_elapsed >= 7`), 100% of the staked amount is available for unstaking.
    *   **Important:** If a user stakes *additional* MCOIN while an existing stake is active, the `start_timestamp` **resets** to the time of the new stake, and the 7-day unlock period restarts for the *entire* staked balance. This simplifies the implementation significantly by avoiding per-stake tracking.

**5. User Journeys & Features**

*   **Presale Buyer:**
    *   Receives 30% MCOIN airdrop (off-chain, pre-TGE or at TGE).
    *   Admin calls `admin_initialize_presale_stake` to create their `UserStake` account and deposit the remaining 70% allocation into the contract's `staked_vault`, setting the initial `start_timestamp`.
    *   **Daily (Days 1-7):** Can call `unstake` to withdraw up to the currently unlocked portion (10% per day cumulative).
    *   **After Day 7:** Can call `unstake` to withdraw up to 100% of the remaining staked amount.
    *   Can call `claim_yield` anytime to receive accrued MCOIN rewards.
    *   Can call `claim_reflections` anytime to receive accrued SOL reflection rewards earned by their stake.
*   **Public Buyer (Wallet Holder Only):**
    *   Buys MCOIN on the market.
    *   Holds MCOIN in their wallet.
    *   Periodically receives SOL reflection distributions automatically from the Off-Chain Bot.
*   **Public Buyer (Staker):**
    *   Buys MCOIN on the market.
    *   Calls `register_user` (if first time interacting).
    *   Calls `stake` to deposit MCOIN. The `start_timestamp` is set/updated, initiating/resetting the 7-day unlock period.
    *   **Daily (Days 1-7 after stake):** Can call `unstake` to withdraw up to the currently unlocked portion (10% per day cumulative).
    *   **After Day 7:** Can call `unstake` to withdraw up to 100% of the remaining staked amount.
    *   Can call `claim_yield` anytime to receive accrued MCOIN rewards.
    *   Can call `claim_reflections` anytime to receive accrued SOL reflection rewards earned by their stake.
*   **Admin:**
    *   Calls `initialize` once to set up the contract configuration (`GlobalConfig`) and PDAs.
    *   Calls `admin_initialize_presale_stake` for each Presale Buyer after TGE.
    *   (Optional: Future functions to update parameters like `yield_rate_bps`).
*   **Off-Chain Bot:**
    *   Runs periodically (e.g., every 30 minutes).
    *   Reads MCOIN balance from the designated tax collection account.
    *   If balance > 0, executes MCOIN -> SOL swap via Raydium.
    *   Reads current total supply from the MCOIN Mint account (Token-2022).
    *   Calls `deposit_reflection_funds` with swapped SOL amount and total supply.
    *   Retrieves list of MCOIN wallet holders (e.g., via RPC `getTokenAccountsByOwner` or an indexer).
    *   Reads the global `reflection_index` before and after its `deposit_reflection_funds` call.
    *   Calculates SOL reflection rewards for each wallet holder based on their balance and the index change.
    *   Distributes calculated SOL amounts to wallet holders (requires SOL funding for the bot).

**6. Contract Implementation Details (V1)**

*   **Key Constants:**
    *   `REFLECTION_INDEX_SCALE: u128 = 1_000_000_000_000;` (1e12)
    *   `SECONDS_IN_DAY: i64 = 86400;`
*   **Accounts:**
    *   `GlobalConfig`:
        *   `admin: Pubkey`
        *   `token_mint: Pubkey` (MCOIN Mint address)
        *   `vault_authority_bump: u8`
        *   `sol_treasury_bump: u8`
        *   `staked_vault: Pubkey` (ATA owned by vault authority holding staked MCOIN)
        *   `reward_vault: Pubkey` (ATA owned by vault authority holding MCOIN for yield)
        *   `total_staked: u64` (Tracks total MCOIN in `staked_vault`)
        *   `reflection_index: u128` (Scaled SOL per token, based on total supply)
        *   `yield_rate_bps: u16` (Annual yield rate for MCOIN staking, e.g., 500 for 5%)
    *   `UserStake`:
        *   `owner: Pubkey`
        *   `staked_amount: u64` (Current total MCOIN staked by user)
        *   `start_timestamp: i64` (Timestamp of the last stake action, resets 7-day unlock)
        *   `last_claimed_index: u128` (User's index at last SOL reflection claim)
        *   `unclaimed_yield: u64` (Accrued MCOIN yield)
        *   `last_yield_claim_time: i64` (Timestamp of last yield calculation/claim)
        *   *(Note: Consider account size limits. Current size ~88 bytes, likely sufficient)*
*   **Instructions:**
    *   `initialize(ctx, yield_rate_bps)`: Sets admin, mint, vaults, bumps, yield rate. Initializes `total_staked=0`, `reflection_index=0`. Requires `admin` signature. Vault ATAs must be created beforehand and ownership given to the `vault_authority` PDA. `sol_treasury` PDA initialized with `space=0`.
    *   `register_user(ctx)`: Initializes `UserStake` account for the signer. Sets `staked_amount=0`, `start_timestamp=0`, `last_claimed_index` to current global index, `unclaimed_yield=0`, `last_yield_claim_time` to current time. Requires `user` signature.
    *   `admin_initialize_presale_stake(ctx, user_pubkey, amount)`: (NEW)
        *   Requires `admin` signature.
        *   Finds/Creates `UserStake` PDA for `user_pubkey`.
        *   Initializes `UserStake` fields: `owner=user_pubkey`, `staked_amount=amount`, `start_timestamp=Clock::get()`, `last_claimed_index`=global, `unclaimed_yield=0`, `last_yield_claim_time=Clock::get()`.
        *   Requires a `source_token_account` in context (owned by admin/bot) holding sufficient MCOIN.
        *   Transfers `amount` MCOIN from `source_token_account` to `staked_vault`.
        *   Updates `GlobalConfig.total_staked`.
    *   `stake(ctx, amount)`:
        *   Requires `user` signature.
        *   Requires `amount > 0`.
        *   Transfers `amount` MCOIN from `user_token_account` to `staked_vault`.
        *   Calculates and adds pending MCOIN yield to `unclaimed_yield` *before* changing principal (use `u128` for intermediate calculation).
        *   Updates `UserStake.staked_amount`.
        *   **Sets `UserStake.start_timestamp = Clock::get()`.**
        *   Sets `UserStake.last_yield_claim_time = Clock::get()`.
        *   Updates `GlobalConfig.total_staked`.
    *   `unstake(ctx, amount_to_withdraw)`:
        *   Requires `user` signature.
        *   Requires `amount_to_withdraw > 0`.
        *   Calls internal calculation logic based on the universal 7-day unlock (see Section 4).
        *   Requires `amount_to_withdraw <= calculated_unlocked_amount`.
        *   Transfers `amount_to_withdraw` MCOIN from `staked_vault` to `user_token_account`.
        *   Updates `UserStake.staked_amount`. If `staked_amount` becomes 0, reset `start_timestamp = 0`.
        *   Updates `GlobalConfig.total_staked`.
    *   `claim_yield(ctx)`:
        *   Requires `user` signature.
        *   Calculates yield accrued since `last_yield_claim_time` (use `u128` intermediate). Adds to `unclaimed_yield`.
        *   Requires `unclaimed_yield > 0` (after calculation).
        *   Transfers `unclaimed_yield` MCOIN from `reward_vault` to `user_token_account`.
        *   Resets `unclaimed_yield = 0`.
        *   Updates `last_yield_claim_time = Clock::get()`.
    *   `deposit_reflection_funds(ctx, sol_amount, total_supply)`: (MODIFIED)
        *   **Requires `admin` signature** (or a designated bot keypair passed as signer).
        *   Requires `total_supply > 0`.
        *   Calculates `index_increase = (sol_amount as u128 * REFLECTION_INDEX_SCALE) / total_supply as u128` (use `u128`).
        *   Adds `index_increase` to `GlobalConfig.reflection_index`.
        *   Requires the `sol_amount` to have already been transferred to the `sol_treasury` PDA externally.
    *   `claim_reflections(ctx)`:
        *   Requires `user` signature.
        *   Calculates pending SOL: `reward = (staked_amount as u128 * (global_index - user_last_index)) / REFLECTION_INDEX_SCALE` (use `u128`).
        *   Requires `reward > 0`.
        *   Requires `sol_treasury.lamports >= reward`.
        *   Transfers `reward` SOL from `sol_treasury` PDA to `user` account via CPI to System Program (`invoke_signed`).
        *   Updates `UserStake.last_claimed_index` to current global index.
*   **Precision:** Use `u128` for intermediate calculations involving multiplication of large `u64` amounts (yield, reflections, vesting percentages) to prevent overflow before final division.

**7. Off-Chain Script Requirements**

*   Secure key management for bot wallet (holding SOL for distributions, authority for tax account).
*   Robust error handling for swaps and SOL transfers.
*   Efficient way to get MCOIN wallet holders and balances (RPC or indexer like Helius).
*   Ability to read MCOIN total supply from its mint account (Token-2022).
*   Logic to track last processed `reflection_index` for wallet distributions.
*   Funding mechanism for bot's SOL for transaction fees and distributions.

**8. Token-2022 Considerations**

*   Use `spl-token-cli create-mint --enable-transfer-fee ...` or equivalent SDK calls.
*   Define fee basis points and maximum fee.
*   Specify the fee collection authority (bot's address).
*   Ensure dApps/wallets interacting with MCOIN support Token-2022.

**9. Raydium Integration**

*   Use Raydium SDK/API for swapping MCOIN to SOL.
*   Requires the MCOIN/SOL liquidity pool to be created and sufficiently funded on Raydium.

**10. Security Considerations**

*   Restrict `initialize` and `admin_initialize_presale_stake` to the admin key.
*   Define specific custom error codes in `lib.rs` (using `#[error_code]`) for clear failure reasons.
*   Thoroughly test calculations for overflows (`u64`, `u128`).
*   Use Anchor constraints (`#[account(...)]`) extensively for validation.
*   Ensure correct PDA derivation and bump usage.
*   Audit contract code.

**11. Future Enhancements (Post V1)**

*   Yield Boosting based on lock duration.
*   Admin functions to update `yield_rate_bps`.

---

### Development Status & Next Steps (as of 2025-04-18)

#### Prioritized Checklist

1. **Expand and Finalize Test Coverage (Highest Priority)**
    - [ ] Write/complete tests for all user journeys:
        - [ ] Presale buyer: admin initializes stake, 7-day unlock, partial/total unstake.
        - [ ] Public buyer: stake, unstake, claim yield, claim SOL reflections.
        - [ ] Edge cases: staking more resets timer, over-unstake fails, unauthorized access.
    - [ ] Test yield accrual and claiming logic.
    - [ ] Test reflection deposit and claiming.
    - [ ] Test error paths (e.g., claim before eligible, double-claim, etc.).
2. **Security and Access Control Review**
    - [ ] Verify all admin-only instructions are restricted.
    - [ ] Review error handling and add custom errors if needed.
3. **Documentation & Integration**
    - [ ] Document contract instructions, accounts, and flows.
    - [ ] Document off-chain bot integration points and requirements.
    - [ ] Add usage notes for vault/ATA setup.
4. **Integration Testing (Optional, but valuable)**
    - [ ] Simulate or mock off-chain bot for reflection flows.
    - [ ] Test contract with real or simulated Raydium pool if possible.
5. **Prepare for Audit/Review (Final Step)**
    - [ ] Clean up code, comments, and ensure clarity.
    - [ ] Ensure all tests pass and CI is green.

---
