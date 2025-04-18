## MCAR-Vesting / MCAR-Staking Contract & Test Suite Improvements

This document outlines recommended enhancements—both on‑chain and off‑chain—to improve robustness, coverage, and maintainability.

### 1. IDL & Codegen
- Automate `anchor build` in CI to regenerate IDL and TypeScript types whenever Rust code changes.
- Add a lint step to validate that new instructions appear in `target/types/...` before merging.

### 2. On‑Chain Program
- **Network & Dependency Management**:
-  - To fully use `anchor build` and regenerate the IDL/TS types, the build environment needs crates.io access. In CI, add a `patch.crates-io` override in the workspace `Cargo.toml` to unify conflicting `toml_datetime` versions (e.g., pin to 0.6.8), or ensure network access. This avoids manual IDL JSON edits.
- **Time‑Warp Testing**: Use Anchor’s `clock` sysvar overrides or a local test validator with `warp` to simulate 7+ days passage for precise vesting tests.
- **Rust Unit Tests**: Add pure Rust tests for:
  - `calculate_unlocked_amount` under 0–7 day scenarios, edge cases.
  - `calculate_yield` around year boundary and overflow conditions.
- **Error Coverage**:
  - Test all custom errors (`InvalidAmount`, `AmountExceedsUnlocked`, `NoYieldToClaim`, etc.) via targeted instruction failures.
- **Rent Handling**:
  - Confirm `sol_treasury` PDA is rent‑exempt (min balance = Rent::minimum_balance(0)). Consider allocating minimal space if future state is added.
- **Access Control**:
  - Add tests for `adminWithdrawSol` failing when called by non‑admin.
- **Emergency & Governance Paths**:
  - Consider on‑chain instruction to update `yield_rate_bps` or `admin` authority under multi‑sig or time‑lock.

### 3. Integration & Stress Tests
- **Batch Distribution**: Measure compute & transaction sizes when distributing to very large user sets. Consider pagination strategies or multiple threads.
- **Reflection Index Invariants**:
  - Validate `reflection_index` never decreases; add assertion in Rust code or test.
- **Off‑Chain Bot Simulation**:
  - Mock a Raydium swap in integration tests by pre‑funding the treasury and calling `deposit_reflection_funds` in a loop.
- **Stress Testing**:
  - Extend `stress-test.ts` to include concurrent `stake`, `unstake`, `claim_yield`, and `claim_reflections` for thousands of users.

### 4. Documentation & Deployment
- Document on‑chain account sizing, PDA seeds, and relationship to Solana Token‑2022 extension.
- Provide example CLI and JS snippets for off‑chain bot operations, including SOL funding management.
- Publish a “Runtime Gas & Fees” audit to estimate per‑instruction cost under mainnet load.

---
_Review and prioritize these improvements based on time, risk, and audit recommendations._