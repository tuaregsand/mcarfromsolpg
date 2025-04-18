 # MCAR Vesting & Staking Test Suite Report

 ## Overview

 The `mcar-vesting/tests/mcar-vesting.ts` test suite provides comprehensive coverage for the core functionalities defined in the PRD (v1.1) and the on‑chain implementation (`lib.rs`). It verifies:

 - **Presale Vesting**: 7‑day unlock matrix with daily increments (0%, 30%, 60%, 100%).
 - **Public Staking**: Bulk withdrawals after idle periods.
 - **SOL Reflections**: Deposit mechanics, index updates, wallet‑only holder calculations, and staker claims.
 - **Yield Accrual**: MCOIN reward accumulation over time and successful yield claims.
 - **Stress Load**: Concurrent registration and staking by 64 users with a global stake invariant.

 ## Alignment with PRD

 **Covered Scenarios**:

 - Initialization of presale airdrop and forced presale stakes.
 - Correct enforcement of the 7‑day unlock schedule (`calculate_unlocked_amount`).
 - Resetting vesting periods when new stakes occur (implicitly tested by public stake flow).
 - SOL reflection flows: deposits, index calculations, distribution calculations, and claims.
 - MCOIN yield accrual (100‑day warp) and `claim_yield` behavior.
 - Concurrency handling and global invariant checks.

 ## Identified Gaps

 1. **Error Case Coverage**  
    - Missing tests for invalid inputs (e.g., zero‑amount stakes/unstakes, `deposit_reflection_funds` with totalSupply=0).  
    - No tests for unauthorized access (e.g., non‑admin calls to admin instructions).

 2. **Admin‑Only Instructions**  
    - `admin_withdraw_sol` is not exercised in tests.  
    - No failure tests for calling admin instructions from unauthorized keys.

 3. **Edge & Boundary Conditions**  
    - No tests for consecutive stakes resetting `start_timestamp`.  
    - No tests for repeated calls to `claim_reflections` or `claim_yield` when no new rewards are pending.  
    - No tests for partial‑stake plus yield interactions between `stake`, `unstake`, and `claim_yield`.

 4. **Deposit & Distribution Logic**  
    - Missing simulation of off‑chain bot distributing SOL to many wallet holders over multiple rounds.  
    - No tests covering `distribution_cursor` or large‑scale reflection distributions.

 5. **Rust Unit Tests**  
    - Pure Rust unit tests (`calculate_unlocked_amount`, `calculate_yield`) as suggested in the improvements document are not present.

 ## Recommendations

 1. **Add Negative Tests**  
    - Verify custom errors (`InvalidAmount`, `InsufficientReflectionPool`, etc.) by intentionally triggering and asserting failures.

 2. **Exercise All Instructions**  
    - Include tests for `admin_withdraw_sol`, error scenarios for admin‑restricted calls, and stake/un-stake edge cases.

 3. **Extend Time‑Warp Scenarios**  
    - Test intermediate days (e.g., days 1–2) and fractional second handling in `calculate_unlocked_amount`.

 4. **Bot & Distribution Simulation**  
    - Mock large wallet holder lists to test reflection distributions and `distribution_cursor` logic.

 5. **Rust‑Level Tests**  
    - Implement unit tests in `lib.rs` for core calculation functions to guard against overflow and logic errors.

 Overall, the current test suite is solid for core PRD flows but should be extended with negative, boundary, and governance scenarios to achieve exhaustive coverage and hardened reliability before mainnet deployment.