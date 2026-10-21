# ADR-002: ERC-20 Approve Race Condition Mitigation

## Status

Accepted (Jul 2026). Implemented in `contracts/token/`.

## Context

The SEP-41 token contract's `approve` function directly overwrites the existing
allowance without checking the previous value, creating a classic front-running
vulnerability: an approved spender can observe a pending `approve` transaction
that changes the allowance and front-run it by spending the original allowance
before the new (lower) allowance takes effect.

## Decision

1. **`approve` rejects non-zero → different non-zero transitions.**  
   The standard `approve` function now panics with
   `TokenError::AllowanceRaceRejected (7)` when a caller attempts to change an
   existing non-zero allowance to a different non-zero value in a single step.

2. **New `increase_allowance` / `decrease_allowance` functions.**  
   These atomic functions read the current allowance, perform checked
   arithmetic, and write the new value — all in one operation, leaving no
   front-running window.

3. **`decrease_allowance` floors at zero.**  
   If `sub_amount >= current_allowance`, the result is clamped to `0` rather
   than panicking. This matches OpenZeppelin's `decreaseAllowance` behavior
   and is safer for callers who may not know the exact current allowance.

4. **SEP-41 signature preserved.**  
   The `approve` function retains its exact standard signature:
   `fn approve(env, from, spender, amount, expiration_ledger)`.

## Consequences

- Existing code that calls `approve` to change a non-zero allowance to a
  different non-zero value will **break**.  Callers must migrate to either the
  two-step pattern (`approve(0)` → `approve(new)`) or use the new
  `increase_allowance`/`decrease_allowance` functions.

- The standard safe pattern (`approve(from, spender, 0, …)` then
  `approve(from, spender, new, …)`) still works.  However, even this pattern
  has a (much smaller) race window, so the new functions are the recommended
  replacement.

- `decrease_allowance` uses floor-at-zero semantics instead of erroring on
  under-allowance.  This was chosen because:
  - It matches the dominant OpenZeppelin convention.
  - It is safer for frontend code that may race with the spender's
    consumption of the allowance (the exact allowance at call time is unknown).
  - No existing code or contract invariant depends on a non-zero minimum
    allowance.

## Test Coverage

26 tests covering:
- Alice/Bob race scenario rejection (exact issue #65 reproduction)
- Safe two-step pattern still works
- Approve zero→non-zero and non-zero→zero (no regressions)
- Same non-zero value re-approval (no-op, allowed)
- `increase_allowance` addition, overflow revert, negative rejection
- `decrease_allowance` subtraction, floor-at-zero, exact-zero, negative rejection
- Auth requirement for all allowance-modifying functions
- Event emission for `approve`, `increase_allowance`, `decrease_allowance`
- Expiration ledger handling for expired allowances and increase/decrease
- `transfer_from` correctly consumes allowance
- Standard token functions (`transfer`, `mint`, `name`, `symbol`, `decimals`)
