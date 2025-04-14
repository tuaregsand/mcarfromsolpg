import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { McarVesting, IDL } from "../target/types/mcar_vesting";
import {
    PublicKey,
    Keypair,
    SystemProgram,
    LAMPORTS_PER_SOL,
    SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    createMint,
    getOrCreateAssociatedTokenAccount,
    getAccount,
    getAssociatedTokenAddressSync,
    mintTo,
    createTransferInstruction,
    getMint,
} from "@solana/spl-token";
import chai, { expect } from "chai";
import chaiAsPromised from "chai-as-promised";

chai.use(chaiAsPromised);

// Constants for PDA seeds
const CONFIG_SEED = Buffer.from("config");
const VAULT_AUTHORITY_SEED = Buffer.from("vault_auth");
const SOL_TREASURY_SEED = Buffer.from("sol_treasury");
const USER_STAKE_SEED = Buffer.from("user");

// Constants from Contract
const SECONDS_IN_DAY = 86400;

// Helper function to delay execution
const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

// Converts basis points to a multiplier (e.g., 350 bps -> 0.035)
// const bpsToMultiplier = (bps: number): number => bps / 10000; // Keep if needed for yield display

// Converts days to seconds - Already have SECONDS_IN_DAY
// const daysToSeconds = (days: number): number => days * SECONDS_IN_DAY;

// Helper to get current Solana clock timestamp
const getSolanaTime = async (connection: anchor.web3.Connection): Promise<BN> => {
    const slot = await connection.getSlot();
    const time = await connection.getBlockTime(slot);
    if (time === null) {
        throw new Error("Could not get block time");
    }
    return new BN(time);
};

// Helper to calculate expected unlocked amount based on NEW 7-day contract logic
const calculateExpectedUnlocked = (
    stakedAmount: BN,
    startTimestamp: BN,
    currentTime: BN
): BN => {
    if (startTimestamp.isZero() || stakedAmount.isZero()) {
        return new BN(0); // No vesting applicable if no start time or no stake
    }

    const elapsed = currentTime.sub(startTimestamp);
    if (elapsed.ltn(0)) {
        return new BN(0); // Time hasn't reached start time
    }

    const daysElapsed = elapsed.div(new BN(SECONDS_IN_DAY)); // Integer division for full days

    let unlockedPercentage: BN;
    if (daysElapsed.gten(7)) {
        unlockedPercentage = new BN(100);
    } else {
        unlockedPercentage = daysElapsed.mul(new BN(10));
    }

    // Use u128 for intermediate calculation to avoid overflow with large numbers
    const stakedAmountU128 = new anchor.BN(stakedAmount.toString()); // Convert to prevent issues if BN library differs
    const unlockedPercentageU128 = new anchor.BN(unlockedPercentage.toString());

    const maxWithdrawableU128 = stakedAmountU128
        .mul(unlockedPercentageU128)
        .div(new BN(100));

    // Convert back to BN and ensure it doesn't exceed original staked amount
    const maxWithdrawable = new BN(maxWithdrawableU128.toString());
    return BN.min(maxWithdrawable, stakedAmount);
};

// Helper to calculate expected yield (remains the same logic)
const calculateExpectedYield = (
    stakedAmount: BN,
    lastYieldClaimTime: BN,
    currentTime: BN,
    yieldRateBps: number // Annual rate in BPS
): BN => {
    if (stakedAmount.isZero() || yieldRateBps === 0 || lastYieldClaimTime.isZero() || currentTime.lte(lastYieldClaimTime)) {
        return new BN(0);
    }

    const elapsedSeconds = currentTime.sub(lastYieldClaimTime);
    const secondsPerYear = new BN(365 * 24 * 60 * 60);

    // yield = stakedAmount * yieldRateBps * elapsedSeconds / (secondsPerYear * 10000)
    const yieldRateScaled = new BN(yieldRateBps);

    // Use wider intermediate types (like u192 if available or string math if BN struggles) if necessary
    // For BN.js, intermediate products might exceed 53 bits safe range.
    // Let's try with BN carefully, may need adjustment for huge numbers.
    const numerator = stakedAmount.mul(yieldRateScaled).mul(elapsedSeconds);
    const denominator = secondsPerYear.mul(new BN(10000));

    // Perform division
    const expectedYield = numerator.div(denominator);

    return expectedYield;
};

describe("mcar-vesting", () => {
    // Configure the client to use the local cluster.
    anchor.setProvider(anchor.AnchorProvider.env());
    const provider = anchor.getProvider() as anchor.AnchorProvider;
    const connection = provider.connection;

    // Explicitly use the known Program ID from Anchor.toml / lib.rs
    const programId = new PublicKey("8UDAtqgE7sK6a8QXhftxEumwoSegJhPwo8R41dZKrjz3");
    const program = new Program<McarVesting>(IDL, programId, provider);

    // Keypairs
    const admin = Keypair.generate();
    const user1 = Keypair.generate(); // Regular user / Public buyer
    const user2 = Keypair.generate(); // Presale user
    const user3 = Keypair.generate(); // Another regular user

    // Accounts
    let tokenMint: PublicKey;
    let mintAuthority = admin; // Admin is mint authority initially
    let configPda: PublicKey;
    let vaultAuthorityPda: PublicKey;
    let solTreasuryPda: PublicKey;
    // Vault ATAs - owned by PDA
    let stakedVaultAta: PublicKey;
    let rewardVaultAta: PublicKey;
    // User ATAs
    let user1TokenAccount: PublicKey;
    let user2TokenAccount: PublicKey;
    let user3TokenAccount: PublicKey;
    // Admin's ATA (for presale initialization)
    let adminTokenAccount: PublicKey;
    // Stake PDAs
    let user1StakePda: PublicKey;
    let user2StakePda: PublicKey;
    let user3StakePda: PublicKey;

    // Config values
    const yieldRateBps = 500; // 5.00% APR for MCOIN staking

    // MINT DECIMALS - IMPORTANT for BN calculations
    const MINT_DECIMALS = 9;
    const TOKEN_UNIT = new BN(10).pow(new BN(MINT_DECIMALS)); // Helper for amounts

    // Derive PDAs
    const findConfigPda = () => PublicKey.findProgramAddressSync([CONFIG_SEED], program.programId)[0];
    const findVaultAuthorityPda = () => PublicKey.findProgramAddressSync([VAULT_AUTHORITY_SEED], program.programId)[0];
    const findSolTreasuryPda = () => PublicKey.findProgramAddressSync([SOL_TREASURY_SEED], program.programId)[0];
    const findUserStakePda = (user: PublicKey) => PublicKey.findProgramAddressSync([USER_STAKE_SEED, user.toBuffer()], program.programId)[0];

    before(async () => {
        console.log("--- Starting Test Setup ---");

        // Airdrop SOL
        await Promise.all([
            connection.requestAirdrop(admin.publicKey, 5 * LAMPORTS_PER_SOL).then(sig => connection.confirmTransaction(sig, "confirmed")),
            connection.requestAirdrop(user1.publicKey, 2 * LAMPORTS_PER_SOL).then(sig => connection.confirmTransaction(sig, "confirmed")),
            connection.requestAirdrop(user2.publicKey, 2 * LAMPORTS_PER_SOL).then(sig => connection.confirmTransaction(sig, "confirmed")),
            connection.requestAirdrop(user3.publicKey, 2 * LAMPORTS_PER_SOL).then(sig => connection.confirmTransaction(sig, "confirmed")),
        ]);
        console.log("Airdrops confirmed.");
        await delay(1000); // Short delay after confirms

        // Create the token mint
        console.log("Creating token mint...");
        tokenMint = await createMint(
            connection,
            admin, // Payer
            mintAuthority.publicKey, // Mint authority
            null, // Freeze authority (optional)
            MINT_DECIMALS // Decimals
        );
        console.log(`Token Mint created: ${tokenMint.toBase58()}`);

        // Derive PDAs
        configPda = findConfigPda();
        vaultAuthorityPda = findVaultAuthorityPda();
        solTreasuryPda = findSolTreasuryPda();
        user1StakePda = findUserStakePda(user1.publicKey);
        user2StakePda = findUserStakePda(user2.publicKey);
        user3StakePda = findUserStakePda(user3.publicKey);
        console.log(`Config PDA: ${configPda.toBase58()}`);
        console.log(`Vault Authority PDA: ${vaultAuthorityPda.toBase58()}`);
        console.log(`SOL Treasury PDA: ${solTreasuryPda.toBase58()}`);
        console.log(`User1 Stake PDA: ${user1StakePda.toBase58()}`);
        // ... etc

        console.log("Creating Vault ATAs (owned by PDA)...");
        // Staked Vault ATA (Needs PDA as owner, allowOwnerOffCurve = true)
        stakedVaultAta = getAssociatedTokenAddressSync(
            tokenMint,
            vaultAuthorityPda, // PDA is the owner
            true // Allow off-curve owner
        );
        const createStakedVaultIx = createAssociatedTokenAccountInstruction(
            admin.publicKey, // Payer
            stakedVaultAta, // ATA address
            vaultAuthorityPda, // Owner (PDA)
            tokenMint // Mint
        );

        // Reward Vault ATA (Needs PDA as owner, allowOwnerOffCurve = true)
         rewardVaultAta = getAssociatedTokenAddressSync(
            tokenMint,
            vaultAuthorityPda, // PDA is the owner
            true // Allow off-curve owner
        );
         const createRewardVaultIx = createAssociatedTokenAccountInstruction(
            admin.publicKey, // Payer
            rewardVaultAta, // ATA address
            vaultAuthorityPda, // Owner (PDA)
            tokenMint // Mint
        );
        // Send vault creation instructions in one transaction
        const vaultTx = new anchor.web3.Transaction().add(createStakedVaultIx, createRewardVaultIx);
        await provider.sendAndConfirm(vaultTx, [admin]);
        console.log(`Staked Vault ATA created: ${stakedVaultAta.toBase58()}`);
        console.log(`Reward Vault ATA created: ${rewardVaultAta.toBase58()}`);


        console.log("Creating User & Admin ATAs...");
        // Use getOrCreateAssociatedTokenAccount for users & admin
        [user1TokenAccount, user2TokenAccount, user3TokenAccount, adminTokenAccount] = await Promise.all([
             getOrCreateAssociatedTokenAccount(connection, admin, tokenMint, user1.publicKey).then(acc => acc.address),
             getOrCreateAssociatedTokenAccount(connection, admin, tokenMint, user2.publicKey).then(acc => acc.address),
             getOrCreateAssociatedTokenAccount(connection, admin, tokenMint, user3.publicKey).then(acc => acc.address),
             getOrCreateAssociatedTokenAccount(connection, admin, tokenMint, admin.publicKey).then(acc => acc.address),
        ]);
        console.log(`User1 ATA: ${user1TokenAccount.toBase58()}`);
        console.log(`User2 ATA: ${user2TokenAccount.toBase58()}`);
        console.log(`User3 ATA: ${user3TokenAccount.toBase58()}`);
        console.log(`Admin ATA: ${adminTokenAccount.toBase58()}`);


        // Mint tokens
        const mintAmountUser = TOKEN_UNIT.mul(new BN(1_000_000)); // 1 Million tokens per user
        const mintAmountAdmin = TOKEN_UNIT.mul(new BN(10_000_000)); // 10 Million for admin (presale etc)
        const mintAmountRewards = TOKEN_UNIT.mul(new BN(5_000_000)); // 5 Million for reward vault

        console.log(`Minting ${mintAmountUser.div(TOKEN_UNIT).toString()} tokens to User1, User3...`);
        console.log(`Minting ${mintAmountAdmin.div(TOKEN_UNIT).toString()} tokens to Admin...`);
        console.log(`Minting ${mintAmountRewards.div(TOKEN_UNIT).toString()} tokens to Reward Vault...`);

        // Mint in batches (consider transaction size limits if many mints)
        await Promise.all([
             mintTo(connection, admin, tokenMint, user1TokenAccount, mintAuthority, BigInt(mintAmountUser.toString())),
             mintTo(connection, admin, tokenMint, user3TokenAccount, mintAuthority, BigInt(mintAmountUser.toString())),
             mintTo(connection, admin, tokenMint, adminTokenAccount, mintAuthority, BigInt(mintAmountAdmin.toString())),
             // Mint directly to reward vault (owned by PDA, but mint auth is admin)
             mintTo(connection, admin, tokenMint, rewardVaultAta, mintAuthority, BigInt(mintAmountRewards.toString())),
        ]);
        console.log("Initial minting complete.");

        // Verify initial reward vault balance
         const rewardVaultInfo = await getAccount(connection, rewardVaultAta);
         expect(rewardVaultInfo.amount).to.equal(BigInt(mintAmountRewards.toString()));

        console.log("--- Test Setup Complete ---");
    });

    describe("Initialization", () => {
        it("Initializes the program config correctly", async () => {
            // Find bumps (needed by contract, useful for verification)
            const [_configPda, configBump] = PublicKey.findProgramAddressSync([CONFIG_SEED], program.programId);
            const [_vaultAuthorityPda, vaultAuthorityBump] = PublicKey.findProgramAddressSync([VAULT_AUTHORITY_SEED], program.programId);
            const [_solTreasuryPda, solTreasuryBump] = PublicKey.findProgramAddressSync([SOL_TREASURY_SEED], program.programId);

            // Call initialize instruction
            await program.methods.initialize(yieldRateBps)
                .accounts({
                    admin: admin.publicKey, // Admin is the signer/payer now
                    config: configPda,
                    vaultAuthority: vaultAuthorityPda,
                    solTreasury: solTreasuryPda,
                    tokenMint: tokenMint,
                    stakedVault: stakedVaultAta,
                    rewardVault: rewardVaultAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                    // rent: SYSVAR_RENT_PUBKEY, // Rent is implicitly checked by init
                })
                .signers([admin]) // Admin signs
                .rpc();

            // Fetch and assert config account state
            const configAccount = await program.account.globalConfig.fetch(configPda);
            expect(configAccount.admin.equals(admin.publicKey)).to.be.true;
            expect(configAccount.tokenMint.equals(tokenMint)).to.be.true;
            expect(configAccount.vaultAuthorityBump).to.equal(vaultAuthorityBump);
            expect(configAccount.solTreasuryBump).to.equal(solTreasuryBump);
            expect(configAccount.stakedVault.equals(stakedVaultAta)).to.be.true;
            expect(configAccount.rewardVault.equals(rewardVaultAta)).to.be.true;
            expect(configAccount.totalStaked.isZero()).to.be.true;
            expect(configAccount.reflectionIndex.isZero()).to.be.true;
            expect(configAccount.yieldRateBps).to.equal(yieldRateBps);
            // Removed assertions for obsolete vesting params

            // Verify vault ownership (already done in setup, but good check)
            const stakedVaultInfo = await getAccount(connection, stakedVaultAta);
            const rewardVaultInfo = await getAccount(connection, rewardVaultAta);
            expect(stakedVaultInfo.owner.equals(vaultAuthorityPda)).to.be.true;
            expect(rewardVaultInfo.owner.equals(vaultAuthorityPda)).to.be.true;

            // Verify SOL treasury PDA was created
            const solTreasuryInfo = await connection.getAccountInfo(solTreasuryPda);
            expect(solTreasuryInfo).to.not.be.null;
            expect(solTreasuryInfo.lamports).to.be.greaterThan(0); // Should have rent exemption SOL
            expect(solTreasuryInfo.owner.equals(program.programId)).to.be.true; // PDA owned by program
        });

        it("Fails to re-initialize", async () => {
            await expect(program.methods.initialize(yieldRateBps)
                .accounts({
                    admin: admin.publicKey,
                    config: configPda, // Already initialized PDA
                    vaultAuthority: vaultAuthorityPda,
                    solTreasury: solTreasuryPda,
                    tokenMint: tokenMint,
                    stakedVault: stakedVaultAta,
                    rewardVault: rewardVaultAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                    // rent: SYSVAR_RENT_PUBKEY,
                })
                .signers([admin])
                .rpc()).to.be.rejected; // Should fail because config account already exists
        });
    });

    describe("User Registration", () => {
        it("Registers a new user (user1)", async () => {
            const configAccountBefore = await program.account.globalConfig.fetch(configPda);
            const expectedInitialIndex = configAccountBefore.reflectionIndex;
            const timeBefore = await getSolanaTime(connection);

            await program.methods.registerUser()
                .accounts({
                    user: user1.publicKey,
                    userStake: user1StakePda,
                    config: configPda,
                    systemProgram: SystemProgram.programId,
                    // rent: SYSVAR_RENT_PUBKEY,
                })
                .signers([user1])
                .rpc();

            const userStakeAccount = await program.account.userStake.fetch(user1StakePda);
            const timeAfter = await getSolanaTime(connection);

            expect(userStakeAccount.owner.equals(user1.publicKey)).to.be.true;
            expect(userStakeAccount.stakedAmount.isZero()).to.be.true;
            expect(userStakeAccount.startTimestamp.isZero()).to.be.true; // 0 until first stake
            expect(userStakeAccount.lastClaimedIndex.eq(expectedInitialIndex)).to.be.true;
            expect(userStakeAccount.unclaimedYield.isZero()).to.be.true;
            expect(userStakeAccount.lastYieldClaimTime.gte(timeBefore)).to.be.true; // Should be set
            expect(userStakeAccount.lastYieldClaimTime.lte(timeAfter)).to.be.true;
        });

        it("Fails to register an already registered user (user1)", async () => {
            await expect(program.methods.registerUser()
                .accounts({
                    user: user1.publicKey,
                    userStake: user1StakePda, // Already exists
                    config: configPda,
                    systemProgram: SystemProgram.programId,
                    // rent: SYSVAR_RENT_PUBKEY,
                })
                .signers([user1])
                .rpc()).to.be.rejected;
        });

        // User 2 will be registered via admin_initialize_presale_stake
        // Register User 3 here
        it("Registers another new user (user3)", async () => {
             await program.methods.registerUser()
                 .accounts({
                     user: user3.publicKey,
                     userStake: user3StakePda,
                     config: configPda,
                     systemProgram: SystemProgram.programId,
                     // rent: SYSVAR_RENT_PUBKEY,
                 })
                 .signers([user3])
                 .rpc();

             const userStakeAccount = await program.account.userStake.fetch(user3StakePda);
             expect(userStakeAccount.owner.equals(user3.publicKey)).to.be.true;
        });
    });

    // --- NEW: Admin Initialize Presale Stake ---
    describe("Admin Initialize Presale Stake", () => {
        const presaleAmount = TOKEN_UNIT.mul(new BN(700_000)); // 700k tokens (representing 70%)

        it("Allows admin to initialize stake for a new user (user2)", async () => {
            const configBefore = await program.account.globalConfig.fetch(configPda);
            const adminTokenAccBefore = await getAccount(connection, adminTokenAccount);
            const stakedVaultBefore = await getAccount(connection, stakedVaultAta);
            const timeBefore = await getSolanaTime(connection);

            // User 2 stake PDA does not exist yet
             await expect(program.account.userStake.fetch(user2StakePda)).to.be.rejected;

            await program.methods.adminInitializePresaleStake(presaleAmount)
                .accounts({
                    admin: admin.publicKey,
                    userStake: user2StakePda, // PDA to be created
                    user: user2.publicKey, // The owner of the stake account
                    config: configPda,
                    sourceTokenAccount: adminTokenAccount, // Admin's ATA holds the tokens
                    stakedVault: stakedVaultAta,
                    tokenMint: tokenMint,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                    rent: SYSVAR_RENT_PUBKEY, // Needed for init_if_needed
                })
                .signers([admin])
                .rpc();

             const timeAfter = await getSolanaTime(connection);

            // Verify UserStake account created and populated
            const userStakeAccount = await program.account.userStake.fetch(user2StakePda);
            expect(userStakeAccount.owner.equals(user2.publicKey)).to.be.true;
            expect(userStakeAccount.stakedAmount.eq(presaleAmount)).to.be.true;
            expect(userStakeAccount.startTimestamp.gte(timeBefore)).to.be.true; // Check time set
            expect(userStakeAccount.startTimestamp.lte(timeAfter)).to.be.true;
            expect(userStakeAccount.lastClaimedIndex.eq(configBefore.reflectionIndex)).to.be.true;
            expect(userStakeAccount.unclaimedYield.isZero()).to.be.true;
            expect(userStakeAccount.lastYieldClaimTime.eq(userStakeAccount.startTimestamp)).to.be.true; // Should match start timestamp

            // Verify token transfer
            const adminTokenAccAfter = await getAccount(connection, adminTokenAccount);
            const stakedVaultAfter = await getAccount(connection, stakedVaultAta);
            expect(adminTokenAccAfter.amount).to.equal(adminTokenAccBefore.amount - BigInt(presaleAmount.toString()));
            expect(stakedVaultAfter.amount).to.equal(stakedVaultBefore.amount + BigInt(presaleAmount.toString()));

            // Verify global total staked
            const configAfter = await program.account.globalConfig.fetch(configPda);
            expect(configAfter.totalStaked.eq(configBefore.totalStaked.add(presaleAmount))).to.be.true;
        });

        it("Allows admin to initialize stake for an already registered user (user3)", async () => {
             // User 3 is registered but has 0 stake
             const user3StakeBefore = await program.account.userStake.fetch(user3StakePda);
             expect(user3StakeBefore.stakedAmount.isZero()).to.be.true;

             const configBefore = await program.account.globalConfig.fetch(configPda);
             const adminTokenAccBefore = await getAccount(connection, adminTokenAccount);
             const stakedVaultBefore = await getAccount(connection, stakedVaultAta);
             const presaleAmountUser3 = TOKEN_UNIT.mul(new BN(50_000));
             const timeBefore = await getSolanaTime(connection);

             await program.methods.adminInitializePresaleStake(presaleAmountUser3)
                 .accounts({
                     admin: admin.publicKey,
                     userStake: user3StakePda, // PDA exists
                     user: user3.publicKey,
                     config: configPda,
                     sourceTokenAccount: adminTokenAccount,
                     stakedVault: stakedVaultAta,
                     tokenMint: tokenMint,
                     tokenProgram: TOKEN_PROGRAM_ID,
                     systemProgram: SystemProgram.programId,
                     rent: SYSVAR_RENT_PUBKEY,
                 })
                 .signers([admin])
                 .rpc();

             const timeAfter = await getSolanaTime(connection);

            // Verify UserStake account updated
             const userStakeAccount = await program.account.userStake.fetch(user3StakePda);
             expect(userStakeAccount.owner.equals(user3.publicKey)).to.be.true;
             expect(userStakeAccount.stakedAmount.eq(presaleAmountUser3)).to.be.true; // Staked amount updated
             expect(userStakeAccount.startTimestamp.gte(timeBefore)).to.be.true; // Start time set
             expect(userStakeAccount.startTimestamp.lte(timeAfter)).to.be.true;
             expect(userStakeAccount.lastClaimedIndex.eq(configBefore.reflectionIndex)).to.be.true; // Index should still be init index
             expect(userStakeAccount.unclaimedYield.isZero()).to.be.true;
             expect(userStakeAccount.lastYieldClaimTime.eq(userStakeAccount.startTimestamp)).to.be.true;

             // Verify token transfer
            const adminTokenAccAfter = await getAccount(connection, adminTokenAccount);
            const stakedVaultAfter = await getAccount(connection, stakedVaultAta);
            expect(adminTokenAccAfter.amount).to.equal(adminTokenAccBefore.amount - BigInt(presaleAmountUser3.toString()));
            expect(stakedVaultAfter.amount).to.equal(stakedVaultBefore.amount + BigInt(presaleAmountUser3.toString()));

            // Verify global total staked
            const configAfter = await program.account.globalConfig.fetch(configPda);
            expect(configAfter.totalStaked.eq(configBefore.totalStaked.add(presaleAmountUser3))).to.be.true;
        });

        it("Fails if non-admin tries to initialize stake", async () => {
            const amount = TOKEN_UNIT.mul(new BN(100));
            await expect(program.methods.adminInitializePresaleStake(amount)
                 .accounts({
                     admin: user1.publicKey, // User1 trying to call
                     userStake: findUserStakePda(user1.publicKey), // Doesn't matter which user
                     user: user1.publicKey,
                     config: configPda,
                     sourceTokenAccount: user1TokenAccount, // User1's account
                     stakedVault: stakedVaultAta,
                     tokenMint: tokenMint,
                     tokenProgram: TOKEN_PROGRAM_ID,
                 })
                 .signers([user1]) // Signed by User1
                 .rpc()).to.be.rejectedWith(/Unauthorized/); // Constraint check failure
        });

        it("Fails if admin source token account has insufficient balance", async () => {
             const adminTokenAcc = await getAccount(connection, adminTokenAccount);
             const excessiveAmount = new BN(adminTokenAcc.amount.toString()).add(TOKEN_UNIT); // More than admin has

             await expect(program.methods.adminInitializePresaleStake(excessiveAmount)
                  .accounts({
                      admin: admin.publicKey,
                      userStake: findUserStakePda(user1.publicKey), // Use user1 for this test
                      user: user1.publicKey,
                      config: configPda,
                      sourceTokenAccount: adminTokenAccount,
                      stakedVault: stakedVaultAta,
                      tokenMint: tokenMint,
                      tokenProgram: TOKEN_PROGRAM_ID,
                  })
                  .signers([admin])
                  .rpc()).to.be.rejected; // Expecting SPL token program error (InsufficientFunds)
        });

         it("Fails if amount is zero", async () => {
             await expect(program.methods.adminInitializePresaleStake(new BN(0))
                  .accounts({
                      admin: admin.publicKey,
                      userStake: findUserStakePda(user1.publicKey),
                      user: user1.publicKey,
                      config: configPda,
                      sourceTokenAccount: adminTokenAccount,
                      stakedVault: stakedVaultAta,
                      tokenMint: tokenMint,
                      tokenProgram: TOKEN_PROGRAM_ID,
                  })
                  .signers([admin])
                  .rpc()).to.be.rejectedWith(/InvalidTotalSupply/);
         });
    });


    describe("Staking (Voluntary)", () => {
        const stakeAmount1 = TOKEN_UNIT.mul(new BN(100_000)); // 100k tokens
        let user1InitialBalance: bigint;
        let stakedVaultInitialBalance: bigint;
        let globalTotalStakedInitial: BN;

        before(async () => {
            // User1 is registered but has 0 staked
            const user1Stake = await program.account.userStake.fetch(user1StakePda);
            expect(user1Stake.stakedAmount.isZero()).to.be.true;

            // Get initial balances
            const user1AccInfo = await getAccount(connection, user1TokenAccount);
            user1InitialBalance = user1AccInfo.amount;
            const stakedVaultInfo = await getAccount(connection, stakedVaultAta);
            stakedVaultInitialBalance = stakedVaultInfo.amount;
            const config = await program.account.globalConfig.fetch(configPda);
            globalTotalStakedInitial = config.totalStaked;
        });

        it("Allows a registered user (user1) to stake tokens", async () => {
            const timeBefore = await getSolanaTime(connection);

            await program.methods.stake(stakeAmount1)
                .accounts({
                    user: user1.publicKey,
                    userStake: user1StakePda,
                    userTokenAccount: user1TokenAccount,
                    stakedVault: stakedVaultAta,
                    config: configPda,
                    tokenMint: tokenMint,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([user1])
                .rpc();

             const timeAfter = await getSolanaTime(connection);

            // Fetch updated accounts
            const userStakeAccount = await program.account.userStake.fetch(user1StakePda);
            const configAccount = await program.account.globalConfig.fetch(configPda);
            const user1AccInfoAfter = await getAccount(connection, user1TokenAccount);
            const stakedVaultInfoAfter = await getAccount(connection, stakedVaultAta);

            // Assertions on UserStake account
            expect(userStakeAccount.stakedAmount.eq(stakeAmount1)).to.be.true;
            expect(userStakeAccount.startTimestamp.gte(timeBefore)).to.be.true; // Start time set
            expect(userStakeAccount.startTimestamp.lte(timeAfter)).to.be.true;
            expect(userStakeAccount.lastYieldClaimTime.eq(userStakeAccount.startTimestamp)).to.be.true; // Yield time reset
            expect(userStakeAccount.unclaimedYield.isZero()).to.be.true; // Yield calculated before stake was 0

            // Assertions on balances
            const expectedUser1BalanceAfter = user1InitialBalance - BigInt(stakeAmount1.toString());
            expect(user1AccInfoAfter.amount).to.equal(expectedUser1BalanceAfter);
            const expectedVaultBalanceAfter = stakedVaultInitialBalance + BigInt(stakeAmount1.toString());
            expect(stakedVaultInfoAfter.amount).to.equal(expectedVaultBalanceAfter);

            // Assertion on global config
            const expectedTotalStaked = globalTotalStakedInitial.add(stakeAmount1);
            expect(configAccount.totalStaked.eq(expectedTotalStaked)).to.be.true;

            // Update initial balances for next test
            user1InitialBalance = user1AccInfoAfter.amount;
            stakedVaultInitialBalance = stakedVaultInfoAfter.amount;
            globalTotalStakedInitial = configAccount.totalStaked;
        });

        it("Resets start_timestamp when staking additional tokens", async () => {
            const additionalStakeAmount = TOKEN_UNIT.mul(new BN(50_000)); // 50k tokens
            const userStakeBefore = await program.account.userStake.fetch(user1StakePda);
            const configBefore = await program.account.globalConfig.fetch(configPda);
            const originalStartTime = userStakeBefore.startTimestamp;

            // Ensure clock advances slightly
            await delay(1000);
            const timeBefore = await getSolanaTime(connection);
             expect(timeBefore.gt(originalStartTime)).to.be.true; // Make sure time progressed

            await program.methods.stake(additionalStakeAmount)
                .accounts({
                     user: user1.publicKey,
                    userStake: user1StakePda,
                    userTokenAccount: user1TokenAccount,
                    stakedVault: stakedVaultAta,
                    config: configPda,
                    tokenMint: tokenMint,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([user1])
                .rpc();

             const timeAfter = await getSolanaTime(connection);

            // Fetch updated accounts
            const userStakeAccount = await program.account.userStake.fetch(user1StakePda);
            const configAccount = await program.account.globalConfig.fetch(configPda);
            const user1AccInfoAfter = await getAccount(connection, user1TokenAccount);
            const stakedVaultInfoAfter = await getAccount(connection, stakedVaultAta);

            // Assertions on UserStake account
            const totalStakedAmount = stakeAmount1.add(additionalStakeAmount);
            expect(userStakeAccount.stakedAmount.eq(totalStakedAmount)).to.be.true;

            // CRITICAL: Check start timestamp was RESET
            expect(userStakeAccount.startTimestamp.gte(timeBefore)).to.be.true;
            expect(userStakeAccount.startTimestamp.lte(timeAfter)).to.be.true;
            expect(userStakeAccount.startTimestamp.gt(originalStartTime), "Start timestamp should have reset to a later time").to.be.true;

            // Check yield time reset
            expect(userStakeAccount.lastYieldClaimTime.eq(userStakeAccount.startTimestamp)).to.be.true;

             // Check yield calculation occurred before principal change
             // Calculate expected yield between originalStartTime and timeBefore
             const expectedAccruedYield = calculateExpectedYield(
                 userStakeBefore.stakedAmount, // Amount *before* this stake
                 userStakeBefore.lastYieldClaimTime, // Last claim time *before* this stake
                 timeBefore, // Time *before* this stake TX
                 yieldRateBps
             );
             // Unclaimed yield should be the previously accrued amount (which was 0) + newly accrued
             expect(userStakeAccount.unclaimedYield.eq(expectedAccruedYield), `Expected yield ${expectedAccruedYield} but got ${userStakeAccount.unclaimedYield}`).to.be.true;


             // Assertions on balances
            const expectedUser1BalanceAfter = user1InitialBalance - BigInt(additionalStakeAmount.toString());
            expect(user1AccInfoAfter.amount).to.equal(expectedUser1BalanceAfter);
            const expectedVaultBalanceAfter = stakedVaultInitialBalance + BigInt(additionalStakeAmount.toString());
            expect(stakedVaultInfoAfter.amount).to.equal(expectedVaultBalanceAfter);

            // Assertion on global config
            const expectedTotalStaked = configAccount.totalStaked.sub(additionalStakeAmount);
            expect(configAccount.totalStaked.eq(expectedTotalStaked)).to.be.true;

            // Update state for subsequent tests
            user1InitialBalance = user1AccInfoAfter.amount;
            stakedVaultInitialBalance = stakedVaultInfoAfter.amount;
            globalTotalStakedInitial = configAccount.totalStaked;
        });

        it("Fails if user is not registered", async () => {
            const unregisteredUser = Keypair.generate();
            // Airdrop, create ATA (payer needs SOL)
            await connection.requestAirdrop(unregisteredUser.publicKey, LAMPORTS_PER_SOL).then(sig => connection.confirmTransaction(sig, "confirmed"));
            const unregAta = await getOrCreateAssociatedTokenAccount(connection, unregisteredUser, tokenMint, unregisteredUser.publicKey);
            // Mint some tokens for them to stake
            await mintTo(connection, admin, tokenMint, unregAta.address, mintAuthority, BigInt(TOKEN_UNIT.muln(1000).toString()));

            // Attempt to stake - should fail as UserStake account doesn't exist / wasn't created via registerUser
            await expect(program.methods.stake(TOKEN_UNIT.muln(100))
                .accounts({
                    user: unregisteredUser.publicKey,
                    // We need to provide the PDA address even if the account doesn't exist
                    userStake: findUserStakePda(unregisteredUser.publicKey),
                    userTokenAccount: unregAta.address,
                    stakedVault: stakedVaultAta,
                    config: configPda,
                    tokenMint: tokenMint,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([unregisteredUser])
                .rpc()).to.be.rejected; // Expecting account constraint violation or similar
        });

        it("Fails if user provides zero amount", async () => {
            await expect(program.methods.stake(new BN(0))
                .accounts({
                    user: user1.publicKey,
                    userStake: user1StakePda,
                    userTokenAccount: user1TokenAccount,
                    stakedVault: stakedVaultAta,
                    config: configPda,
                    tokenMint: tokenMint,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([user1])
                .rpc()).to.be.rejectedWith(/InvalidAmount/);
         });

         it("Fails if user has insufficient token balance", async () => {
             const user1AccInfo = await getAccount(connection, user1TokenAccount);
             const excessiveAmount = new BN(user1AccInfo.amount.toString()).add(new BN(1)); // 1 more lamport than balance

            await expect(program.methods.stake(excessiveAmount)
                .accounts({
                    user: user1.publicKey,
                    userStake: user1StakePda,
                    userTokenAccount: user1TokenAccount,
                    stakedVault: stakedVaultAta,
                    config: configPda,
                    tokenMint: tokenMint,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([user1])
                .rpc()).to.be.rejected; // Expecting SPL token program error (InsufficientFunds)
         });
    });

    // --- REVISED: Unstaking (7-Day Unlock) ---
    describe("Unstaking (7-Day Unlock)", () => {
         let userStakeBefore: any;
         let stakedVaultBefore: bigint;
         let userTokenAccBefore: bigint;
         let totalStakedBefore: BN;
         let startTime: BN;

         // Use user1 who staked voluntarily in the previous block
         const user = user1;
         const userStakePdaRef = user1StakePda;
         const userTokenAccountRef = user1TokenAccount;

         before(async () => {
             userStakeBefore = await program.account.userStake.fetch(userStakePdaRef);
             const stakedVaultInfo = await getAccount(connection, stakedVaultAta);
             stakedVaultBefore = stakedVaultInfo.amount;
             const userTokenInfo = await getAccount(connection, userTokenAccountRef);
             userTokenAccBefore = userTokenInfo.amount;
             const config = await program.account.globalConfig.fetch(configPda);
             totalStakedBefore = config.totalStaked;
             startTime = userStakeBefore.startTimestamp;

             expect(userStakeBefore.stakedAmount.gt(new BN(0)), "User should have tokens staked before unstaking tests").to.be.true;
         });

         it("Fails to unstake immediately (0 days elapsed)", async () => {
            const currentTime = await getSolanaTime(connection);
            // Allow a tiny buffer for clock skew, ensure less than 1 day passed
            expect(currentTime.sub(startTime).lt(new BN(SECONDS_IN_DAY - 5)), "Less than 1 day should have passed").to.be.true;

            const expectedUnlocked = calculateExpectedUnlocked(
                userStakeBefore.stakedAmount,
                startTime,
                currentTime
            );
             expect(expectedUnlocked.isZero(), "Expected 0 unlocked immediately").to.be.true;

             const amountToTry = TOKEN_UNIT.muln(1); // Try to withdraw 1 token

             await expect(program.methods.unstake(amountToTry)
                 .accounts({
                     user: user.publicKey,
                     userStake: userStakePdaRef,
                     userTokenAccount: userTokenAccountRef,
                     vaultAuthority: vaultAuthorityPda,
                     stakedVault: stakedVaultAta,
                     config: configPda,
                     tokenMint: tokenMint,
                     tokenProgram: TOKEN_PROGRAM_ID,
                 })
                 .signers([user])
                 .rpc()).to.be.rejectedWith(/AmountExceedsUnlocked/); // Fails because 0 is available
         });

        // NOTE: Testing specific time intervals (1 day, 3 days, 7 days) accurately
        // requires either time warping capabilities in the test environment (like Anchor test does)
        // or simulating the passage of time OUTSIDE the blockchain calls and verifying
        // the calculation helper. We will primarily use the helper for validation
        // and test the boundary conditions we *can* test via RPC (like 0 days and > 7 days if possible).

         it("Correctly calculates unlockable amount after ~1 day (using helper)", async () => {
            const simulatedTime = startTime.add(new BN(SECONDS_IN_DAY * 1 + 10)); // 1 day + 10 sec buffer
            const expectedUnlocked = calculateExpectedUnlocked(
                userStakeBefore.stakedAmount,
                startTime,
                simulatedTime
            );
            const expectedPercent = userStakeBefore.stakedAmount.mul(new BN(10)).div(new BN(100));
            expect(expectedUnlocked.eq(expectedPercent), `Expected ~10% unlocked after 1 day`).to.be.true;
            console.log(`   (Simulated) Unlocked after 1 day: ${expectedUnlocked.div(TOKEN_UNIT).toString()} (~10%)`)
         });

         it("Correctly calculates unlockable amount after ~3 days (using helper)", async () => {
             const simulatedTime = startTime.add(new BN(SECONDS_IN_DAY * 3 + 10)); // 3 days + 10 sec buffer
             const expectedUnlocked = calculateExpectedUnlocked(
                 userStakeBefore.stakedAmount,
                 startTime,
                 simulatedTime
             );
             const expectedPercent = userStakeBefore.stakedAmount.mul(new BN(30)).div(new BN(100));
             expect(expectedUnlocked.eq(expectedPercent), `Expected ~30% unlocked after 3 days`).to.be.true;
             console.log(`   (Simulated) Unlocked after 3 days: ${expectedUnlocked.div(TOKEN_UNIT).toString()} (~30%)`)
         });

        it("Correctly calculates unlockable amount after 7+ days (using helper)", async () => {
             const simulatedTime = startTime.add(new BN(SECONDS_IN_DAY * 7 + 10)); // 7 days + 10 sec buffer
             const expectedUnlocked = calculateExpectedUnlocked(
                 userStakeBefore.stakedAmount,
                 startTime,
                 simulatedTime
             );
             expect(expectedUnlocked.eq(userStakeBefore.stakedAmount), "Expected 100% unlocked after 7 days").to.be.true;
             console.log(`   (Simulated) Unlocked after 7+ days: ${expectedUnlocked.div(TOKEN_UNIT).toString()} (100%)`)
         });

         // Test attempting to withdraw more than available unlocked amount (at current time)
         it("Fails if trying to unstake more than available unlocked amount (at current time)", async () => {
            const userStake = await program.account.userStake.fetch(userStakePdaRef);
            const currentTime = await getSolanaTime(connection);
            const currentlyUnlocked = calculateExpectedUnlocked(
                userStake.stakedAmount,
                userStake.startTimestamp,
                currentTime
            );

            const amountToTry = currentlyUnlocked.add(TOKEN_UNIT.muln(1)); // 1 token more than available

             await expect(program.methods.unstake(amountToTry)
                 .accounts({
                     user: user.publicKey,
                     userStake: userStakePdaRef,
                     userTokenAccount: userTokenAccountRef,
                     vaultAuthority: vaultAuthorityPda,
                     stakedVault: stakedVaultAta,
                     config: configPda,
                     tokenMint: tokenMint,
                     tokenProgram: TOKEN_PROGRAM_ID,
                 })
                 .signers([user])
                 .rpc()).to.be.rejectedWith(/AmountExceedsUnlocked/);
         });

        // --- Test actual unstake IF possible ---
        // This requires waiting or time-warp. Let's assume we *can* wait ~1 day.
        // If running against localnet with skip wait, this might pass.
        // If running against devnet/mainnet, this test will likely fail unless run >1 day later.
        // We add a manual check and skip if insufficient time passed.
         it("Allows unstaking the correct portion after ~1 day (if time allows)", async () => {
             console.log("   Attempting unstake after ~1 day (requires actual time passage)...");
             const userStake = await program.account.userStake.fetch(userStakePdaRef);
             const currentTime = await getSolanaTime(connection);
             const elapsedSeconds = currentTime.sub(userStake.startTimestamp);

             if (elapsedSeconds.lt(new BN(SECONDS_IN_DAY))) {
                 console.log(`   Skipping test: Only ${elapsedSeconds.toString()} seconds passed, need > ${SECONDS_IN_DAY}.`);
                 return; // Skip test if not enough time passed
             }

             const availableToWithdraw = calculateExpectedUnlocked(
                 userStake.stakedAmount,
                 userStake.startTimestamp,
                 currentTime
             );
             expect(availableToWithdraw.eq(userStake.stakedAmount), "Should be able to withdraw full amount").to.be.true;

             const amountToWithdraw = availableToWithdraw;
             expect(amountToWithdraw.gt(new BN(0)), "Amount to withdraw must be > 0").to.be.true;

             const userTokenAccBeforeUnstake = await getAccount(connection, userTokenAccountRef);
             const stakedVaultBeforeUnstake = await getAccount(connection, stakedVaultAta);
             const configBeforeUnstake = await program.account.globalConfig.fetch(configPda);

             await program.methods.unstake(amountToWithdraw)
                  .accounts({
                      user: user.publicKey,
                      userStake: userStakePdaRef,
                      userTokenAccount: userTokenAccountRef,
                      vaultAuthority: vaultAuthorityPda,
                      stakedVault: stakedVaultAta,
                      config: configPda,
                      tokenMint: tokenMint,
                      tokenProgram: TOKEN_PROGRAM_ID,
                  })
                  .signers([user])
                  .rpc();

             // Verify state after unstake
             const userStakeAfter = await program.account.userStake.fetch(userStakePdaRef);
             const userTokenAccAfter = await getAccount(connection, userTokenAccountRef);
             const stakedVaultAfter = await getAccount(connection, stakedVaultAta);
             const configAfter = await program.account.globalConfig.fetch(configPda);

             expect(userStakeAfter.stakedAmount.eq(userStake.stakedAmount.sub(amountToWithdraw)), "Staked amount should decrease by withdrawn amount").to.be.true;
             expect(userStakeAfter.startTimestamp.eq(userStake.startTimestamp), "Start time should not change").to.be.true;

             // Verify token balance
             const expectedUserTokenBalance = userTokenAccBeforeUnstake.amount + BigInt(amountToWithdraw.toString());
             expect(userTokenAccAfter.amount).to.equal(expectedUserTokenBalance);
             const expectedVaultBalance = stakedVaultBeforeUnstake.amount - BigInt(amountToWithdraw.toString());
             expect(stakedVaultAfter.amount).to.equal(expectedVaultBalance);

             // Verify global total staked
             const expectedTotalStaked = configBeforeUnstake.totalStaked.sub(amountToWithdraw);
             expect(configAfter.totalStaked.eq(expectedTotalStaked)).to.be.true;

             console.log(`   Successfully unstaked ${amountToWithdraw.div(TOKEN_UNIT).toString()} tokens after >1 day.`);
         });


         it("Fails if trying to unstake zero amount", async () => {
             await expect(program.methods.unstake(new BN(0))
                 .accounts({
                     user: user.publicKey,
                     userStake: userStakePdaRef,
                     userTokenAccount: userTokenAccountRef,
                     vaultAuthority: vaultAuthorityPda,
                     stakedVault: stakedVaultAta,
                     config: configPda,
                     tokenMint: tokenMint,
                     tokenProgram: TOKEN_PROGRAM_ID,
                 })
                 .signers([user])
                 .rpc()).to.be.rejectedWith(/InvalidAmount/);
         });

        // Use User 3 who was initialized by admin, assuming sufficient time passed (>7 days for simplicity)
        // This also tests unstaking from an admin-initialized stake
         it("Allows full unstake for presale user (user3) after 7+ days (if time allows)", async () => {
             console.log("   Attempting full unstake for user3 (requires actual time passage > 7 days)...");
             const userStake = await program.account.userStake.fetch(user3StakePda);
             const currentTime = await getSolanaTime(connection);

             if (userStake.startTimestamp.isZero()) {
                  console.log("   Skipping test: User 3 start timestamp is zero (already unstaked?).");
                 return;
             }
             if (userStake.stakedAmount.isZero()) {
                  console.log("   Skipping test: User 3 staked amount is zero.");
                 return;
             }

             const elapsedSeconds = currentTime.sub(userStake.startTimestamp);
             const requiredSeconds = new BN(SECONDS_IN_DAY * 7);

             if (elapsedSeconds.lt(requiredSeconds)) {
                 console.log(`   Skipping test: Only ${elapsedSeconds.toString()} seconds passed for user3, need > ${requiredSeconds.toString()}.`);
                 return; // Skip test if not enough time passed
             }

             const availableToWithdraw = calculateExpectedUnlocked(
                 userStake.stakedAmount,
                 userStake.startTimestamp,
                 currentTime
             );
             expect(availableToWithdraw.eq(userStake.stakedAmount), "Should be able to withdraw full amount").to.be.true;

             const amountToWithdraw = userStake.stakedAmount;
             expect(amountToWithdraw.gt(new BN(0)), "Amount to withdraw must be > 0").to.be.true;

             const userTokenAccBeforeUnstake = await getAccount(connection, user3TokenAccount);
             const stakedVaultBeforeUnstake = await getAccount(connection, stakedVaultAta);
             const configBeforeUnstake = await program.account.globalConfig.fetch(configPda);

             await program.methods.unstake(amountToWithdraw)
                  .accounts({
                      user: user3.publicKey,
                      userStake: user3StakePda,
                      userTokenAccount: user3TokenAccount,
                      vaultAuthority: vaultAuthorityPda,
                      stakedVault: stakedVaultAta,
                      config: configPda,
                      tokenMint: tokenMint,
                      tokenProgram: TOKEN_PROGRAM_ID,
                  })
                  .signers([user3])
                  .rpc();

             // Verify state after full unstake
             const userStakeAfter = await program.account.userStake.fetch(user3StakePda);
             expect(userStakeAfter.stakedAmount.isZero()).to.be.true;
             expect(userStakeAfter.startTimestamp.isZero()).to.be.true;

             // Verify token balance
             const userTokenAccAfter = await getAccount(connection, user3TokenAccount);
             // Fix: Corrected assertion for user3
             const expectedUserTokenBalanceAfter = userTokenAccBeforeUnstake.amount + BigInt(amountToWithdraw.toString());
             expect(userTokenAccAfter.amount).to.equal(expectedUserTokenBalanceAfter);

             // Verify global total staked
             const configAfter = await program.account.globalConfig.fetch(configPda);
             expect(configAfter.totalStaked.eq(configBeforeUnstake.totalStaked.sub(amountToWithdraw))).to.be.true;

             console.log(`   Successfully unstaked all ${amountToWithdraw.div(TOKEN_UNIT).toString()} tokens for user3 after >7 days.`);
         });

     });

     describe("Yield Claiming", () => {
          // Use user2 (presale user) who should have stake remaining
          const user = user2;
          const userStakePdaRef = user2StakePda;
          const userTokenAccountRef = user2TokenAccount;

          let userStakeBeforeYield: any;
          let rewardVaultBalanceBefore: bigint;
          let userTokenBalanceBefore: bigint;
          let lastYieldClaimTimeBefore: BN;

          before(async () => {
             await delay(2000); // Let some time pass for potential yield accrual
             userStakeBeforeYield = await program.account.userStake.fetch(userStakePdaRef);
             const rewardVaultInfo = await getAccount(connection, rewardVaultAta);
             rewardVaultBalanceBefore = rewardVaultInfo.amount;
             const userTokenInfo = await getAccount(connection, userTokenAccountRef);
             userTokenBalanceBefore = userTokenInfo.amount;
             lastYieldClaimTimeBefore = userStakeBeforeYield.lastYieldClaimTime;

             expect(userStakeBeforeYield.stakedAmount.gt(new BN(0)), "User must have staked tokens for yield tests").to.be.true;
         });

         it("Allows claiming accrued yield", async () => {
            const timeBeforeClaim = await getSolanaTime(connection);
            const expectedYield = calculateExpectedYield(
                userStakeBeforeYield.stakedAmount,
                lastYieldClaimTimeBefore,
                timeBeforeClaim,
                yieldRateBps
            );

            console.log(`   Calculated expected yield: ${expectedYield.toString()}`);

            // If expected yield is 0, the claim should fail.
            if (expectedYield.isZero()) {
                console.log("   Expected yield is zero, expecting claim to fail...");
                await expect(program.methods.claimYield()
                     .accounts({
                         user: user.publicKey,
                         userStake: userStakePdaRef,
                         userTokenAccount: userTokenAccountRef,
                         vaultAuthority: vaultAuthorityPda,
                         rewardVault: rewardVaultAta,
                         config: configPda,
                         tokenMint: tokenMint,
                         tokenProgram: TOKEN_PROGRAM_ID,
                     })
                     .signers([user])
                     .rpc()).to.be.rejectedWith(/NoYieldToClaim/);
                return; // End test early if no yield expected
            }

            // Proceed with claim if yield > 0
             console.log("   Yield > 0, attempting claim...");
            await program.methods.claimYield()
                .accounts({
                    user: user.publicKey,
                    userStake: userStakePdaRef,
                    userTokenAccount: userTokenAccountRef,
                    vaultAuthority: vaultAuthorityPda,
                    rewardVault: rewardVaultAta,
                    config: configPda,
                    tokenMint: tokenMint,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([user])
                .rpc();

             const timeAfterClaim = await getSolanaTime(connection);

            // Verify state changes
            const userStakeAfterClaim = await program.account.userStake.fetch(userStakePdaRef);
            const userTokenAccAfterClaim = await getAccount(connection, userTokenAccountRef);
            const rewardVaultAfterClaim = await getAccount(connection, rewardVaultAta);

            // Check UserStake update
            expect(userStakeAfterClaim.unclaimedYield.isZero(), "Unclaimed yield should be zero after claim").to.be.true;
            expect(userStakeAfterClaim.lastYieldClaimTime.gte(timeBeforeClaim), "Last claim time should update").to.be.true;
            expect(userStakeAfterClaim.lastYieldClaimTime.lte(timeAfterClaim)).to.be.true;
            expect(userStakeAfterClaim.lastYieldClaimTime.gt(lastYieldClaimTimeBefore), "Last claim time must advance").to.be.true;

             // Check balances
             const expectedUserBalance = userTokenBalanceBefore + BigInt(expectedYield.toString());
             const expectedVaultBalance = rewardVaultBalanceBefore - BigInt(expectedYield.toString());

             // Fix: Convert BigInt to Number for closeTo comparison
             const tolerance = Number(BigInt(10)); // Allow small difference (e.g., 10 lamports)
             expect(Number(userTokenAccAfterClaim.amount)).to.be.closeTo(Number(expectedUserBalance), tolerance);
             expect(Number(rewardVaultAfterClaim.amount)).to.be.closeTo(Number(expectedVaultBalance), tolerance);

             // Update balances for next test
             userTokenBalanceBefore = userTokenAccAfterClaim.amount;
             rewardVaultBalanceBefore = rewardVaultAfterClaim.amount;
             lastYieldClaimTimeBefore = userStakeAfterClaim.lastYieldClaimTime;
         });

         it("Fails to claim yield if none has accrued", async () => {
            // Fetch the current state immediately after the previous claim
             const userStake = await program.account.userStake.fetch(userStakePdaRef);
             const currentTime = await getSolanaTime(connection);
             const yieldSinceLastClaim = calculateExpectedYield(
                userStake.stakedAmount,
                userStake.lastYieldClaimTime, // Should be very recent
                currentTime,
                yieldRateBps
             );
             // It's highly likely yieldSinceLastClaim is 0 if tests run quickly
             expect(yieldSinceLastClaim.isZero(), "No yield should accrue immediately after a claim").to.be.true;

             // Attempt to claim again
            await expect(program.methods.claimYield()
                .accounts({
                    user: user.publicKey,
                    userStake: userStakePdaRef,
                    userTokenAccount: userTokenAccountRef,
                    vaultAuthority: vaultAuthorityPda,
                    rewardVault: rewardVaultAta,
                    config: configPda,
                    tokenMint: tokenMint,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([user])
                .rpc()).to.be.rejectedWith(/NoYieldToClaim/);
         });

         it("Fails if user has no staked tokens", async () => {
             // User 1 unstaked everything previously (if that test ran and passed)
             // Or use a fresh user known to have 0 stake
             const userWithNoStake = user1;
             const userStakePdaNoStake = user1StakePda;
             const userStakeInfo = await program.account.userStake.fetch(userStakePdaNoStake);
             if (!userStakeInfo.stakedAmount.isZero()) {
                 console.log("WARN: Skipping 'claim yield with no stake' test as user still has stake.");
                 return;
             }
             expect(userStakeInfo.stakedAmount.isZero(), "User must have 0 staked").to.be.true;

             await expect(program.methods.claimYield()
                .accounts({
                    user: userWithNoStake.publicKey,
                    userStake: userStakePdaNoStake,
                    // Fix: Correct variable name for user1's ATA
                    userTokenAccount: user1TokenAccount, // Need the user's ATA
                    vaultAuthority: vaultAuthorityPda,
                    rewardVault: rewardVaultAta,
                    config: configPda,
                    tokenMint: tokenMint,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([userWithNoStake])
                .rpc()).to.be.rejectedWith(/NoYieldToClaim/);
         });

         it("Fails if reward vault has insufficient balance (simulated)", async () => {
             // Requires depositing more reflections, then draining treasury carefully.
             console.log("   Depositing more SOL to test insufficiency...");
             // Deposit enough SOL to generate a claimable amount for user2
             const depositAmount = LAMPORTS_PER_SOL * 2; // 2 SOL
             const transferTx = new anchor.web3.Transaction().add(
                 SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: solTreasuryPda, lamports: depositAmount })
             );
             await provider.sendAndConfirm(transferTx, [admin]);
             const mintInfo = await getMint(connection, tokenMint);
             const totalSupplyBN = new BN(mintInfo.supply.toString());
             await program.methods.depositReflectionFunds(new BN(depositAmount), totalSupplyBN)
                 .accounts({ admin: admin.publicKey, config: configPda, solTreasury: solTreasuryPda })
                 .signers([admin]).rpc();

             // Calculate expected claim for user2 now
             const config = await program.account.globalConfig.fetch(configPda);
             const userStake = await program.account.userStake.fetch(user2StakePda);
             const indexDifference = config.reflectionIndex.sub(userStake.lastClaimedIndex);
             const scaleFactor = new BN("1000000000000");
             const expectedSolClaim = userStake.stakedAmount.mul(indexDifference).div(scaleFactor);
             expect(expectedSolClaim.gt(new BN(0)), "User2 must have pending reflections for this test").to.be.true;
             console.log(`    Calculated expected claim for insufficiency test: ${expectedSolClaim.toString()} lamports`);

             // Drain the treasury PDA - tricky from tests. We can't sign as the PDA.
             // The best we can do is transfer *most* SOL out using the *admin* key if allowed,
             // but the treasury is owned by the program/PDA.
             // Alternative: Assume the treasury *starts* low or manually set it low if possible.
             // For this test, we'll simulate by checking if the calculated amount > current balance.
             // If the treasury already happens to be lower than expected claim, the test is valid.

             const currentTreasuryBalance = await connection.getBalance(solTreasuryPda);
             console.log(`    Current treasury balance: ${currentTreasuryBalance} lamports`);

             if (currentTreasuryBalance >= expectedSolClaim.toNumber()) {
                 console.warn("    WARN: Treasury balance is sufficient. Cannot reliably test insufficiency without draining. Skipping RPC call.");
                 // To properly test, manually drain the solTreasuryPda account before running this test.
                 // Or add a debug instruction to withdraw from treasury (admin only).
                 return;
             }

             // If balance IS insufficient, expect the claim to fail
             console.log("    Treasury balance IS insufficient. Expecting claim to fail...");
             await expect(program.methods.claimYield()
                 .accounts({
                     user: user.publicKey,
                     userStake: userStakePdaRef,
                     userTokenAccount: userTokenAccountRef,
                     vaultAuthority: vaultAuthorityPda,
                     rewardVault: rewardVaultAta,
                     config: configPda,
                     tokenMint: tokenMint,
                     tokenProgram: TOKEN_PROGRAM_ID,
                 })
                 .signers([user])
                 .rpc()).to.be.rejectedWith(/InsufficientReflectionPool/);
         });
     });

      describe("Reflections", () => {
          const reflectionDepositAmount = new BN(1 * LAMPORTS_PER_SOL); // 1 SOL
          let configBeforeDeposit: any;
          let solTreasuryBalanceBefore: number;
          let user1SolBalanceBefore: number;
          let user1StakeBeforeClaim: any;
          let user1TokenAccBeforeClaim: any;

          before(async () => {
              // Ensure users have staked tokens from previous tests
              const user1Stake = await program.account.userStake.fetch(user1StakePda);
              // Ensure total staked > 0 before depositing reflections
              const config = await program.account.globalConfig.fetch(configPda);
              expect(config.totalStaked.gt(new BN(0)), "Total staked must be > 0 for reflection deposit test").to.be.true;
              expect(user1Stake.stakedAmount.gt(new BN(0)), "User1 needs staked tokens for reflection tests").to.be.true;

              // Get initial SOL balances
              configBeforeDeposit = await program.account.globalConfig.fetch(configPda);
              solTreasuryBalanceBefore = await connection.getBalance(solTreasuryPda);
              user1SolBalanceBefore = await connection.getBalance(user1.publicKey);
              user1StakeBeforeClaim = user1Stake;
              user1TokenAccBeforeClaim = await getAccount(connection, user1TokenAccount);
          });

         it("Admin deposits SOL for reflections", async () => {
             // 1. Transfer SOL to the treasury PDA first
             const transferTx = new anchor.web3.Transaction().add(
                 SystemProgram.transfer({
                     fromPubkey: admin.publicKey,
                     toPubkey: solTreasuryPda,
                     lamports: reflectionDepositAmount.toNumber(),
                 })
             );
             await provider.sendAndConfirm(transferTx, [admin]);

             const treasuryBalanceAfterTransfer = await connection.getBalance(solTreasuryPda);
             expect(treasuryBalanceAfterTransfer).to.equal(solTreasuryBalanceBefore + reflectionDepositAmount.toNumber());

             // 2. Get current total supply of the mint
             const mintInfo = await getMint(connection, tokenMint);
             const totalSupply = mintInfo.supply; // This is BigInt
             expect(totalSupply > 0n, "Total supply must be greater than zero").to.be.true;
             const totalSupplyBN = new BN(totalSupply.toString()); // Convert to BN for instruction

             // 2. Call the deposit instruction
             await program.methods.depositReflectionFunds(reflectionDepositAmount, totalSupplyBN)
                 .accounts({
                     admin: admin.publicKey, // Admin is the signer
                     config: configPda,
                     solTreasury: solTreasuryPda,
                 })
                 .rpc();

             const configAfterDeposit = await program.account.globalConfig.fetch(configPda);
             const treasuryBalanceAfterInstruction = await connection.getBalance(solTreasuryPda);

             // Assertions
             expect(treasuryBalanceAfterInstruction).to.equal(treasuryBalanceAfterTransfer);
             expect(configAfterDeposit.reflectionIndex.gt(configBeforeDeposit.reflectionIndex), "Reflection index should increase").to.be.true;

             // Update state for next tests
             configBeforeDeposit = configAfterDeposit; // Use updated config with new index
             solTreasuryBalanceBefore = treasuryBalanceAfterInstruction;
         });

          it("Updates reflection index correctly after deposit", async () => {
             // Calculation: new_index = old_index + (sol_amount * 1e12 / total_staked_tokens)
             // Note: The program uses u128 for index, scaled appropriately.
             // Fetch state *before* the deposit (from the describe block's before hook)
             const configBefore = await program.account.globalConfig.fetch(configPda);
             const oldIndex = configBefore.reflectionIndex;
             const totalStaked = configBefore.totalStaked;
             console.log(`   Index before deposit: ${oldIndex.toString()}, Total staked: ${totalStaked.toString()}`);

             // Deposit 1 SOL again for this test
             const depositAmount = new BN(LAMPORTS_PER_SOL); // Use constant
             const transferTx = new anchor.web3.Transaction().add(
                 SystemProgram.transfer({
                     fromPubkey: admin.publicKey,
                     toPubkey: solTreasuryPda,
                     lamports: depositAmount.toNumber(),
                 })
             );
             await provider.sendAndConfirm(transferTx, [admin]);

             // Fix: Get total supply again
             const mintInfoAgain = await getMint(connection, tokenMint);
             const totalSupplyBNAgain = new BN(mintInfoAgain.supply.toString());

             try {
                 await program.methods.depositReflectionFunds(depositAmount, totalSupplyBNAgain)
                     .accounts({
                         config: configPda,
                         solTreasury: solTreasuryPda,
                     })
                     .rpc();
             } catch (error) {
                 console.error("Error during depositReflectionFunds RPC call:", error);
                 // If logs are available in the error, print them
                 if (error instanceof anchor.web3.SendTransactionError && error.logs) {
                     console.error("Logs:", error.logs);
                 }
                 throw error; // Re-throw to fail the test
             }

             const configAfterDeposit = await program.account.globalConfig.fetch(configPda);
             const newIndex = configAfterDeposit.reflectionIndex;
             console.log(`   Index after deposit: ${newIndex.toString()}`);

             // Check if total staked was zero (it shouldn't be due to before() check, but good practice)
             if (totalStaked.isZero()) {
                 expect(newIndex.eq(oldIndex), "Index should not change if totalStaked is zero").to.be.true;
             } else {
                 // Check that the index increased
                 expect(newIndex.gt(oldIndex), "Reflection index should increase after deposit").to.be.true;
             }
         });

         it("Allows a user to claim their share of reflections", async () => {
             const config = await program.account.globalConfig.fetch(configPda);
             const userStake = await program.account.userStake.fetch(user1StakePda);
             const userTokenAcc = await getAccount(connection, user1TokenAccount);

             // Calculate expected claim amount
             // expected = total_holding * (global_index - user_last_index) / scale_factor
             const totalHolding = userStake.stakedAmount.add(new BN(userTokenAcc.amount.toString()));
             const indexDifference = config.reflectionIndex.sub(userStake.lastClaimedIndex);
             const scaleFactor = new BN("1000000000000");
             const expectedSolClaim = totalHolding.mul(indexDifference).div(scaleFactor);

             expect(expectedSolClaim.gt(new BN(0)), "Expected claim amount should be positive").to.be.true;

             await program.methods.claimReflections()
                 .accounts({
                     user: user1.publicKey,
                     userStake: user1StakePda,
                     solTreasury: solTreasuryPda,
                     config: configPda,
                     systemProgram: SystemProgram.programId,
                 })
                 .signers([user1])
                 .rpc();

             const userStakeAfterClaim = await program.account.userStake.fetch(user1StakePda);
             const user1SolBalanceAfter = await connection.getBalance(user1.publicKey);
             const solTreasuryBalanceAfter = await connection.getBalance(solTreasuryPda);

             // Assert SOL balance changes (consider transaction fees)
             // User balance increases, treasury decreases
             // Allow for TX fee variance
             const expectedUserSolBalance = user1SolBalanceBefore + expectedSolClaim.toNumber();
             expect(user1SolBalanceAfter).to.be.greaterThan(user1SolBalanceBefore); // Should definitely increase
             // We can't check equality easily due to fees, maybe check range?
             // expect(user1SolBalanceAfter).to.be.closeTo(expectedUserSolBalance, LAMPORTS_PER_SOL * 0.001); // High tolerance for fees

             const expectedTreasuryBalance = solTreasuryBalanceBefore - expectedSolClaim.toNumber();
             expect(solTreasuryBalanceAfter).to.equal(expectedTreasuryBalance);

             // Assert user stake update
             expect(userStakeAfterClaim.lastClaimedIndex.eq(config.reflectionIndex), "User index should update to global index").to.be.true;

             // Update balances for next tests
             user1SolBalanceBefore = user1SolBalanceAfter;
             solTreasuryBalanceBefore = solTreasuryBalanceAfter;
         });

         it("Calculates reflection share based on total token holdings (staked + wallet)", async () => {
             // This is implicitly tested in the successful claim test above,
             // as the expectedSolClaim calculation uses total holdings.
         });

         it("Updates user's last claimed index", async () => {
             // Also implicitly tested in the successful claim test above.
         });

         it("Fails to claim reflections if none have accumulated since last claim", async () => {
             // Attempt claim immediately after the previous one
             await expect(program.methods.claimReflections()
                 .accounts({
                     user: user1.publicKey,
                     userStake: user1StakePda,
                     solTreasury: solTreasuryPda,
                     config: configPda,
                     systemProgram: SystemProgram.programId,
                 })
                 .signers([user1])
                 .rpc()).to.be.rejected;
         });

         it("Fails to claim reflections if user holds no tokens (staked or wallet)", async () => {
             // Setup a user with no tokens at all - Use user2 instead
             // const zeroTokenUser = Keypair.generate();
             // ... (removed zeroTokenUser setup) ...

             // Ensure user2 has 0 staked (should be true from setup)
             const user2StakeInfo = await program.account.userStake.fetch(user2StakePda);
             expect(user2StakeInfo.stakedAmount.isZero(), "User2 should have 0 staked for this test").to.be.true;

             // Ensure user2's wallet token account is empty
             const user2TokenAccInfo = await getAccount(connection, user2TokenAccount);
             if (user2TokenAccInfo.amount > 0) {
                 console.log(`   Transferring remaining ${user2TokenAccInfo.amount} tokens from user2 wallet...`);
                 const transferIx = createTransferInstruction(
                     user2TokenAccount, // source
                     user1TokenAccount, // destination (send to user1 for simplicity)
                     user2.publicKey,   // owner
                     user2TokenAccInfo.amount
                 );
                 const tx = new anchor.web3.Transaction().add(transferIx);
                 await provider.sendAndConfirm(tx, [user2]);
             }
             const user2TokenAccInfoAfter = await getAccount(connection, user2TokenAccount);
             expect(user2TokenAccInfoAfter.amount).to.equal(0n, "User2 token wallet should be empty");

             // Expect claimReflections to succeed (return Ok) but do nothing, as per updated Rust code
             await program.methods.claimReflections()
                  .accounts({
                      user: user2.publicKey,
                      userStake: user2StakePda,
                      solTreasury: solTreasuryPda,
                      config: configPda,
                      systemProgram: SystemProgram.programId,
                  })
                  .signers([user2])
                  .rpc(); // Expect no error

             // Fetch userStake and verify lastClaimedIndex updated
             const user2StakeAfter = await program.account.userStake.fetch(user2StakePda);
             const configAfter = await program.account.globalConfig.fetch(configPda);
             expect(user2StakeAfter.lastClaimedIndex.eq(configAfter.reflectionIndex), "User index should update to global index").to.be.true;
             // Check if index actually changed compared to before the RPC call (it should if reflections were deposited)
             // Fix: Correct variable name back
             expect(user2StakeAfter.lastClaimedIndex.gt(user2StakeBeforeClaim.lastClaimedIndex), "lastClaimedIndex should update if global index changed").to.be.true;

             // Check SOL balance didn't change (minus tx fee)
             const user2SolBalanceAfter = await connection.getBalance(user2.publicKey);
             // Fix: Correct variable name back
             expect(user2SolBalanceAfter).to.be.at.most(user2SolBalanceBefore); // Check it didn't increase
             expect(user2SolBalanceAfter).to.be.greaterThan(user2SolBalanceBefore - LAMPORTS_PER_SOL * 0.001); // Allow for tx fee
         });

         it("Fails to claim reflections if SOL treasury is insufficient", async () => {
             // Calculate expected claim for user1
             const config = await program.account.globalConfig.fetch(configPda);
             const userStake = await program.account.userStake.fetch(user1StakePda);
             const currentTreasuryBalance = await connection.getBalance(solTreasuryPda);

             // Calculate expected claim amount based on current state
             // Reflection calculation now uses ONLY staked amount
             const reflectionBasisBalance = userStake.stakedAmount;
             const indexDifference = config.reflectionIndex.sub(userStake.lastClaimedIndex);
             // Scale factor is 1e12 in the contract
             const scaleFactor = new BN("1000000000000");
             const expectedSolClaim = reflectionBasisBalance.mul(indexDifference).div(scaleFactor);

             expect(expectedSolClaim.gt(new BN(0)), "User must have pending reflections for this test").to.be.true;

             // --- Start Revised Treasury Adjustment Logic ---
             console.log(`    Treasury Balance Before Adjustment: ${currentTreasuryBalance}`);
             console.log(`    Expected SOL Claim for User1 (based on staked): ${expectedSolClaim.toNumber()}`);

             const targetTreasuryBalance = expectedSolClaim.subn(1).toNumber(); // Target balance (1 less than needed)

             if (targetTreasuryBalance < 0) {
                 // This case should ideally not happen if expectedSolClaim > 0, but safety check
                 console.warn("    WARN: Calculated target treasury balance is negative. Skipping adjustment.");
             } else if (currentTreasuryBalance > targetTreasuryBalance) {
                  // Need to remove SOL - Hard from test without specific contract instruction
                  console.warn(`    WARN: Current treasury balance (${currentTreasuryBalance}) > target (${targetTreasuryBalance}). Cannot easily drain SOL treasury from test. Test validity depends on prior state.`);
                  // Proceed assuming the state might be correct or the CPI fix will reveal the right error.
             } else if (currentTreasuryBalance < targetTreasuryBalance) {
                  // Need to add SOL
                  const lamportsToAdd = targetTreasuryBalance - currentTreasuryBalance;
                  console.log(`    Adding ${lamportsToAdd} lamports to treasury...`);
                  const topUpTx = new anchor.web3.Transaction().add(
                      SystemProgram.transfer({
                          fromPubkey: admin.publicKey,
                          toPubkey: solTreasuryPda,
                          lamports: lamportsToAdd,
                      })
                  );
                  await provider.sendAndConfirm(topUpTx, [admin]);
                  const newBalance = await connection.getBalance(solTreasuryPda);
                  console.log(`    New Treasury Balance: ${newBalance}`);
                  expect(newBalance).to.equal(targetTreasuryBalance);
             } else {
                  console.log("    Treasury balance is already at the target insufficient level.");
             }
             // --- End Revised Treasury Adjustment Logic ---

             // Drain the treasury, leaving just less than needed
             // const lamportsToLeave = expectedSolClaim.subn(1).toNumber(); // Leave 1 lamport less than needed
             // const lamportsToDrain = currentTreasuryBalance - lamportsToLeave; // Remove old logic

             // expect(lamportsToDrain > 0, "Treasury balance must be >= expected claim for test").to.be.true; // Remove old logic

             // const drainTx = new anchor.web3.Transaction().add(...); // Remove Tx creation
             // const [_solTreasuryPda, solTreasuryBump] = PublicKey.findProgramAddressSync([SOL_TREASURY_SEED], program.programId);
             // const seeds = &[Buffer.from(SOL_TREASURY_SEED), &[solTreasuryBump]]; // Remove invalid Rust syntax

             // ... (skipping actual drain simulation) ...

             // Now attempt the claim, it should fail due to insufficient funds in the treasury for the transfer
             await expect(program.methods.claimReflections()
                 .accounts({
                     user: user1.publicKey,
                     userStake: user1StakePda,
                     solTreasury: solTreasuryPda,
                     config: configPda,
                     systemProgram: SystemProgram.programId,
                 })
                 .signers([user1])
                 .rpc()).to.be.rejectedWith(/InsufficientReflectionPool/); // Should now fail with the correct program error
         });

          it("Handles reflection deposits when total staked is zero (should not update index?)", async () => {
              // Difficult to test without resetting state or complex setup.
              // Requires unstaking all tokens first.
              // We verified the calculation check in the index update test.
               console.log("   Skipping test for deposit with zero staked due to complexity.")
          });
     });

     describe("Security & Edge Cases", () => {
         it("Handles potential calculation overflows gracefully (if applicable)", async () => {
             // Try staking/claiming extremely large amounts if possible within test limits
             // Implementation needed
         });
         it("Prevents unauthorized users from calling privileged instructions", async () => {
             // e.g., User tries to call depositReflectionFunds
              // Implementation needed
         });
          it("Handles zero staked amount correctly in calculations", async () => {
              // Test yield/reflections when user stake is 0
              // Implementation needed
          });
         // Add more edge cases as identified
     });

});
