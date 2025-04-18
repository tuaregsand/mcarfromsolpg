# Solana Self-CPI Exploration Video Summary

## Introduction (0:00 - 1:12)

*   The video is a Solana tutorial focused on exploring **Self-CPIs** (Cross-Program Invocations where a program calls itself).
*   The speaker initially believed Self-CPIs were not possible on Solana, perhaps due to misremembering documentation about re-entrancy or other limitations.
*   His perspective changed after encountering a Stack Exchange answer regarding event emission in the Anchor framework, which explicitly mentioned using Self-CPIs (specifically via the `emit_cpi!` macro).
*   This video aims to be an **exploratory session** to:
    *   Prove whether Self-CPIs are indeed possible in a standard Solana program (outside of Anchor's specific macros).
    *   Experiment and understand how they work and what their characteristics are (e.g., compute cost, limitations).
    *   Have some fun playing around with the concept.
*   The knowledge gained here will be applied practically in a future video discussing **event emission** best practices on Solana.

## Verifying Self-CPI Possibility (1:13 - 1:44)

*   The speaker shows the [Solana Stack Exchange question](https://solana.stackexchange.com/questions/2106/is-it-a-good-practice-to-rely-on-program-logs-for-indexing) about relying on program logs for indexing.
*   He highlights the accepted answer which states logs can be truncated but events can be emitted using the Anchor `emit_cpi!` macro, which works via a **Self-CPI call**.
*   He also shows the linked [Anchor GitHub issue #2408](https://github.com/coral-xyz/anchor/issues/2408) ("new event api") where Armani Ferrante (Anchor creator) proposed the solution: "recursively CPI into the program with that instruction and the serialized event as data."
*   This confirms that Self-CPI is a known pattern, at least within the Anchor ecosystem for events. The speaker decides to test it with a plain Solana program.

## Defining CPI and Self-CPI (1:44 - 2:59)

*   **CPI (Cross-Program Invocation):** One Solana program calling an instruction in *another* Solana program.
*   **Self-CPI:** A Solana program invoking one of *its own* instructions via the `invoke` or `invoke_signed` functions. This is essentially a recursive call at the program instruction level.
*   The speaker revisits his previous assumptions, questioning why it *wouldn't* be possible, comparing it conceptually to deploying the same program twice and calling between them.

## Experiment Setup (2:59 - 4:54)

1.  **Project Init:** Creates a new Rust library project (`cargo init --lib`).
2.  **Dependencies:** Adds `solana-program`.
3.  **Basic Program (`lib.rs`):**
    *   Sets up the standard entrypoint (`process_instruction`).
    *   Adds a simple log message: `msg!("program called");`.
    *   Returns `Ok(())`.
4.  **Wallet/Deployment:**
    *   Creates a keypair (`solana-keygen grind`).
    *   Gets devnet SOL via the web faucet.
    *   Fixes common version mismatches between `solana-program` dependency and the `solana-cli` version, and fixes the `Cargo.lock` format version.
    *   Builds the program (`cargo build-sbf`).
    *   Deploys the program (`solana program deploy`).
5.  **Client Script (`callProgram.ts`):**
    *   Uses a basic template (implicitly installing `@solana/web3.js` and related packages).
    *   Sets up RPC connection.
    *   Loads the payer keypair.
    *   Defines the deployed program's address.
    *   Creates a `TransactionInstruction` targeting the deployed program (initially with no accounts or data).
    *   Uses `@solana/web3.js` functions (`sendAndConfirmTransaction`) to send the transaction.
    *   **Result:** Successfully calls the program once, seeing the "program called" log.

## Implementing and Testing Self-CPI (4:54 - 5:52)

1.  **Modify Program (`lib.rs`):**
    *   The `process_instruction` function now expects the *program's own account info* to be passed as the first account (`accounts[0]`).
    *   It constructs a *new* `Instruction` struct:
        *   `program_id`: Set to the key of `accounts[0]` (i.e., its own Program ID).
        *   `accounts`: An empty vector (`Vec<AccountMeta>`).
        *   `data`: An empty vector (`Vec<u8>`).
    *   It calls `solana_program::program::invoke()` with the newly created instruction and the *original `accounts` slice* passed into the entrypoint.
2.  **Modify Client (`callProgram.ts`):**
    *   Adds the program's own address (`program`) to the `keys` array of the `TransactionInstruction`, marking it as `isSigner: false`, `isWritable: false`.
3.  **Build, Deploy, Run:**
    *   **Result:** The transaction logs show multiple "program called" messages, confirming recursive calls.
    *   The transaction **fails** with the error: `Cross-program invocation call depth too deep`. The logs show 5 successful invokes (invoke[1] to invoke[5]) before failure.

## Exploring Sysvar Instructions (5:52 - 7:18)

*   The speaker wants to determine the current CPI depth within the program.
*   **Adds Sysvar:**
    *   Adds `use solana_program::sysvar::instructions::{load_current_index_checked, get_instruction_relative};`
    *   Adds the `sysvar::instructions::ID` account info as the *second* account (`accounts[1]`) in `lib.rs`.
    *   Adds the `SYSVAR_INSTRUCTIONS_PUBKEY` as the second account in the client script (`callProgram.ts`).
*   **Experiment 1: Current Index:**
    *   Uses `load_current_index_checked(instructions_sysvar_account_info)` to get the current instruction index.
    *   Logs this index.
    *   **Result:** The log always shows `instruction index 0`, even in deeper CPI calls. This sysvar function returns the index relative to the *top-level transaction*, not the current CPI stack.
*   **Experiment 2: Top-Level Instruction Check:**
    *   Uses `get_instruction_relative(0, instructions_sysvar_account_info)` to get the top-level instruction.
    *   Checks if `current_top_level_ix.program_id == program_id`.
    *   **Result:** This condition is true for *all* levels of the self-CPI, as the program ID is always the same. It cannot distinguish top-level from inner calls.
    *   Checks if `current_top_level_ix.data == instruction_data`.
    *   **Result:** This condition is *only* true for the initial, top-level call (invoke[1]) because the instruction data passed in subsequent self-CPIs is different (or empty in the initial test). This *can* be used to detect if the current execution is the top-level one, *provided* the instruction data differs between the top-level call and subsequent CPIs.
*   **Conclusion:** The Instructions Sysvar does **not** provide a direct way to know the current CPI depth.

## Manual Depth Tracking & Cost Comparison (7:18 - 9:12)

*   **Implementation:**
    *   In `lib.rs`, extracts a `depth` value from the first byte of `instruction_data` (defaulting to 0 if none).
    *   Adds a base case/guard: `if depth == 4 { return Ok(()); }`.
    *   When creating the instruction for the `invoke` call, sets its `data` to `vec![depth + 1]`.
*   **Result:** The self-CPI now runs successfully, stopping after 5 calls (depths 0-4) without hitting the max depth error. Compute units consumed: ~10,156.
*   **Comparison:**
    *   Replaces the `invoke` call with a direct recursive call to `process_instruction(program_id, accounts, &vec![depth+1])`.
    *   Builds, deploys, and runs.
    *   **Result:** Runs successfully with the same logic. Compute units consumed: ~861.
*   **Conclusion:** Direct recursive function calls are significantly (~10x+) cheaper in terms of compute units than using Self-CPIs for the same recursive logic.

## Account Modifications in Self-CPI (9:12 - 10:46)

*   **Experiment 1: `realloc` and Write:**
    *   Adds a `data_account` as the *third* account (`accounts[2]`) in `lib.rs`, marked writable in the client script.
    *   Adds `data_account.realloc(data_account.data_len() + 1, false)` to increase size by 1 byte per call.
    *   Adds `data_account.try_borrow_mut_data()` to get mutable access.
    *   Writes the `depth + 100` to `data[depth as usize]`.
    *   Adds the necessary `SystemProgram.createAccount` instruction in the client script (`callProgram.ts`).
    *   Runs. **Fails** with `Instruction tries to borrow reference for account which is already borrowed`.
    *   **Reason:** The mutable borrow via `try_borrow_mut_data()` is held across the `invoke` call, but `invoke` also needs to borrow the accounts listed in `account_infos` (including the `data_account`).
    *   **Fix:** Explicitly `drop(data);` *before* the `invoke` call to release the mutable borrow.
    *   Runs again. **Succeeds**.
    *   Checks account state (`solana account data_account.address`): Shows length 5 bytes. Data is `[103, 102, 101, 100, 0]` (using `base58` or similar to decode). Confirms `realloc` and writes work across self-CPI calls, respecting the order of execution (last write was depth 3, written to index 3).
*   **Experiment 2: `realloc` Limit:**
    *   Changes `realloc` size increase to `+ 2 * 1024` (2KB).
    *   Runs. **Succeeds**. Total data size becomes 1 byte (initial) + 5 calls * 2KB = ~10KB + 1 byte.
    *   Changes `realloc` size increase to `+ 10 * 1024` (10KB).
    *   Runs. **Fails** with `Account data size realloc limited to 10240 in inner instructions`.
*   **Conclusion:** `realloc` works within CPIs, but the total increase *per top-level instruction* is capped at 10KB. Account borrows must be explicitly managed (dropped) before invoking CPIs that reuse the same account.

## Final Takeaways (10:46 - End)

*   Self-CPI *is* possible on Solana using `invoke`.
*   It's computationally much more expensive than direct function recursion.
*   There's no built-in mechanism (like a sysvar) to reliably determine the *current CPI depth*. You only know the *top-level* instruction index.
*   Account data can be modified (written to, realloc'd up to 10KB increase per top-level instruction) within self-CPIs, but careful management of borrows (`drop`) is necessary before the recursive `invoke` if accounts are reused.
*   The main practical reason to use Self-CPI is for **event emission**, providing a reliable mechanism for indexers to track program activity, as direct program logs can be truncated. Anchor uses this pattern.
*   The speaker finds the lack of CPI depth context potentially problematic from a security/predictability standpoint but acknowledges it's how the runtime works.

---

## Notes on Usefulness and Potential Applications

**Usefulness:**

1.  **Reliable Event Emission:** This is the **most significant and practical use case**. By performing a Self-CPI with specific instruction data representing an event, programs guarantee that this "event" data is recorded as part of the transaction's inner instructions, which are *not* truncated like program logs. Off-chain indexers can then filter transactions for CPIs to this program with the specific event "discriminator" or structure in the data, ensuring they capture all intended events. Anchor's event system (`emit!`/`emit_cpi!`) is built on this.
2.  **Atomic Checkpoints (Complex):** While less common, a self-CPI could act as an atomic boundary. If the logic *before* the `invoke` succeeds but the logic *within* the invoked instruction (or subsequent CPIs) fails, the state changes from before the `invoke` might still be committed depending on how the failure occurs and how accounts are handled. This allows for more granular atomicity than a single instruction provides, but it's complex to manage correctly.
3.  **Circumventing Stack Depth Limits (Rarely Advisable):** Direct recursion in Rust (as shown in the compute comparison) can hit Rust's own stack limits faster than Solana's BPF call depth limit *might* be hit. Self-CPI resets the Rust stack frame for each call, potentially allowing deeper "logical" recursion, but at a very high compute cost and still limited by the BPF call depth (5 in the video for self-CPI, usually 4 for distinct CPIs). This is generally not a recommended pattern.

**What Can You Build With This:**

1.  **Custom Event Frameworks:** Build logging or event systems similar to Anchor's but without using the Anchor framework itself. You define specific instruction variants within your program solely for logging structured data via Self-CPI.
2.  **Enhanced Indexing:** Create programs where specific state transitions or actions trigger Self-CPI "events" that make it much easier for off-chain services (like UIs, analytics platforms) to track meaningful activity without relying on potentially unreliable log parsing or polling account states constantly.
3.  **On-Chain State Machines (with caution):** Implement complex state transitions where each step might involve a Self-CPI. This ensures that the "event" of transitioning state is reliably recorded. However, the compute cost and complexity might make alternative designs (like storing state in an account and having separate instructions) more practical.
4.  **Callback Mechanisms (Anchor-style):** Anchor uses Self-CPIs internally not just for events but sometimes for structuring callbacks or ensuring certain code paths execute after a CPI to another program returns successfully. While possible natively, it adds complexity and gas cost.

**Important Caveats:**

*   **Compute Cost:** Self-CPIs are expensive. Use them judiciously, primarily when the reliability of recording the action (like an event) outweighs the compute cost. Don't use them for simple recursive computation.
*   **Complexity:** Managing the instruction data (like the depth counter) and account borrows adds complexity compared to direct function calls.
*   **Call Depth Limit:** Solana imposes a strict limit on CPI depth (usually 4, but self-CPI seems to allow 5 based on the video). Deeply nested Self-CPIs will fail.
*   **Realloc Limit:** Account `realloc` within CPIs is limited (10KB increase per top-level instruction).