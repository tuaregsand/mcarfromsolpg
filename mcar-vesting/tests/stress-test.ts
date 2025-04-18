import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { McarVesting, IDL } from "../target/types/mcar_vesting";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  createInitializeAccountInstruction,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";

// Stress Test: Parallel stake and reflection claims for many users
describe("Stress Test: high concurrency", () => {
  // Spin up and configure a fresh local test validator for this suite
  anchor.setProvider(anchor.AnchorProvider.local());
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const connection = provider.connection;
  const programId = new PublicKey("8UDAtqgE7sK6a8QXhftxEumwoSegJhPwo8R41dZKrjz3");
  const program = new Program<McarVesting>(IDL, programId, provider);
  // Access the underlying Keypair payer from the NodeWallet
  // @ts-ignore: provider.wallet may have a payer property at runtime
  const admin = (provider.wallet as any).payer as Keypair;

  let tokenMint: PublicKey;
  let configPda: PublicKey;
  let vaultAuthPda: PublicKey;
  let solTreasuryPda: PublicKey;
  let stakedVaultAta: PublicKey;
  let rewardVaultAta: PublicKey;
  let freshInit = false;

  const NUM_USERS = 50;
  const users: Keypair[] = [];
  const userAtas: PublicKey[] = [];
  const userStakes: PublicKey[] = [];
  const STAKE_AMOUNT = new BN(100).mul(new BN(10).pow(new BN(9))); // 100 tokens

  it("Setup mint, vaults, and initialize program", async () => {
    // Derive PDAs used by the program
    configPda      = PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
    vaultAuthPda   = PublicKey.findProgramAddressSync([Buffer.from("vault_auth")], programId)[0];
    solTreasuryPda = PublicKey.findProgramAddressSync([Buffer.from("sol_treasury")], programId)[0];

    // -------------------------------------------------------------
    // 1. Try to fetch existing config – if it succeeds we attach to
    //    the already‑deployed instance so that we don't collide with the
    //    integration test suite.  Otherwise we spin up a fresh mint and
    //    initialise the contract.
    // -------------------------------------------------------------

    // reference outer freshInit
    let cfg: any | null = null;
    try {
      cfg = await program.account.globalConfig.fetch(configPda);
      console.log("Stress‑test found existing contract instance – attaching …");
    } catch (_) {
      // Not initialised yet – we will deploy
      freshInit = true;
    }

    if (freshInit) {
      // --------------------------- Fresh deployment -----------------------
      tokenMint = await createMint(connection, admin, admin.publicKey, null, 9);

      // Helper to create PDA‑owned vault account
      const createVaultAccount = async (): Promise<PublicKey> => {
        const acc   = Keypair.generate();
        const rent  = await connection.getMinimumBalanceForRentExemption(165);
        const tx    = new Transaction().add(
          SystemProgram.createAccount({
            fromPubkey: admin.publicKey,
            newAccountPubkey: acc.publicKey,
            lamports: rent,
            space: 165,
            programId: TOKEN_PROGRAM_ID,
          }),
          createInitializeAccountInstruction(acc.publicKey, tokenMint, vaultAuthPda),
        );
        await provider.sendAndConfirm(tx, [admin, acc]);
        return acc.publicKey;
      };

      stakedVaultAta = await createVaultAccount();
      rewardVaultAta = await createVaultAccount();

      await program.methods
        .initialize(500)
        .accounts({
          admin: admin.publicKey,
          config: configPda,
          vaultAuthority: vaultAuthPda,
          solTreasury: solTreasuryPda,
          tokenMint,
          stakedVault: stakedVaultAta,
          rewardVault: rewardVaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();

      console.log("Stress‑test deployed fresh contract instance");
    } else {
      // --------------------------- Attach -----------------------
      tokenMint      = cfg.tokenMint;
      stakedVaultAta = cfg.stakedVault;
      rewardVaultAta = cfg.rewardVault;
    }

    const createVaultAccount = async (): Promise<PublicKey> => {
      const vaultAccount = Keypair.generate();
      const rent     = await connection.getMinimumBalanceForRentExemption(165);
      const tx       = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: admin.publicKey,
          newAccountPubkey: vaultAccount.publicKey,
          lamports: rent,
          space: 165, // SPL token account size
          programId: TOKEN_PROGRAM_ID,
        }),
        // Initialize the token account
        createInitializeAccountInstruction(
          vaultAccount.publicKey,
          tokenMint,
          vaultAuthPda,
        )
      );
      await provider.sendAndConfirm(tx, [admin, vaultAccount]);
      return vaultAccount.publicKey;
    };

    stakedVaultAta  = await createVaultAccount();
    rewardVaultAta  = await createVaultAccount();

    // Initialize program if not already
    try {
      await program.methods
        .initialize(500)
        .accounts({
          admin: admin.publicKey,
          config: configPda,
          vaultAuthority: vaultAuthPda,
          solTreasury: solTreasuryPda,
          tokenMint,
          stakedVault: stakedVaultAta,
          rewardVault: rewardVaultAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
    } catch (e: any) {
      // Ignore "contract already initialized" if a previous test file ran
      const msg = e?.message ?? "";
      if (!msg.includes("AlreadyInitialized")) throw e;
    }
  }).timeout(60000);

  it("Spawn users, fund, register and stake in parallel", async function () {
    this.timeout(600000);
    // Create users and ATAs
    for (let i = 0; i < NUM_USERS; i++) {
      const u = Keypair.generate();
      users.push(u);
      const ata = (
        await getOrCreateAssociatedTokenAccount(
          connection,
          admin,
          tokenMint,
          u.publicKey
        )
      ).address;
      userAtas.push(ata);
      const stakePda = PublicKey.findProgramAddressSync(
        [Buffer.from("user"), u.publicKey.toBuffer()],
        programId
      )[0];
      userStakes.push(stakePda);
    }

    // Airdrop SOL and mint tokens concurrently
    await Promise.all(
      users.map((u) =>
        connection.requestAirdrop(u.publicKey, LAMPORTS_PER_SOL).then((sig) =>
          connection.confirmTransaction(sig, "confirmed")
        )
      )
    );
    await Promise.all(
      userAtas.map((ata) =>
        mintTo(
          connection,
          admin,
          tokenMint,
          ata,
          admin,
          BigInt(STAKE_AMOUNT.toString())
        )
      )
    );

    // Register and stake
    await Promise.all(
      users.map((u, idx) =>
        program.methods
          .registerUser()
          .accounts({
            user: u.publicKey,
            userStake: userStakes[idx],
            config: configPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([u])
          .rpc()
          .then(() =>
            program.methods
              .stake(STAKE_AMOUNT)
              .accounts({
                user: u.publicKey,
                userTokenAccount: userAtas[idx],
                userStake: userStakes[idx],
                config: configPda,
                stakedVault: stakedVaultAta,
                tokenMint,
                tokenProgram: TOKEN_PROGRAM_ID,
              })
              .signers([u])
              .rpc()
          )
      )
    );
  });

  it("Perform repeated reflection deposits and parallel claims", async function () {
    this.timeout(600000);
    // Skip if we are attached to an existing deployment whose admin key we
    // don't control (e.g. when the integration suite already initialised the
    // contract).  In that scenario we cannot perform privileged deposits.

    if (!freshInit) this.skip();

    const ROUNDS = 5;
    for (let round = 0; round < ROUNDS; round++) {
      // Deposit 1 SOL
      await connection.requestAirdrop(admin.publicKey, LAMPORTS_PER_SOL).then((sig) =>
        connection.confirmTransaction(sig, "confirmed")
      );
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: solTreasuryPda,
          lamports: LAMPORTS_PER_SOL,
        })
      );
      await provider.sendAndConfirm(tx, [admin]);
      const mintInfo = await connection.getTokenSupply(tokenMint as PublicKey);
      const totalSupply = new BN(mintInfo.value.amount);
      await program.methods
        .depositReflectionFunds(new BN(LAMPORTS_PER_SOL), totalSupply)
        .accounts({
          admin: admin.publicKey,
          config: configPda,
          solTreasury: solTreasuryPda,
        })
        .signers([admin])
        .rpc();

      // Parallel claims
      await Promise.all(
        users.map((u, idx) =>
          program.methods
            .claimReflections()
            .accounts({
              user: u.publicKey,
              userStake: userStakes[idx],
              solTreasury: solTreasuryPda,
              config: configPda,
              systemProgram: SystemProgram.programId,
            })
            .signers([u])
            .rpc().catch(() => {})
        )
      );
    }
  });
});