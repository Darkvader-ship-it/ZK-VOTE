# ERC-20 Approve Race Condition Mitigation

## The Vulnerability

The ERC-20 `approve` function has a well-known front-running vulnerability
(originally described in
[ERC-20 issue #129](https://github.com/ethereum/EIPs/issues/129)).

### Alice & Bob Example

1. Alice calls `approve(Bob, 100)` — Bob can now spend up to 100 of Alice's
   tokens.
2. Alice later decides she only wants Bob to have 50, so she calls
   `approve(Bob, 50)`.
3. Bob sees Alice's second transaction in the mempool and **front-runs** it by
   spending the original 100.
4. Alice's `approve(Bob, 50)` lands *after* Bob's spend, resetting the
   allowance to 50.
5. **Result:** Bob extracted 150 tokens (100 + 50) instead of the intended 50.

## The Fix

### Modified `approve` behavior

The standard `approve` function now **rejects** the following transition:

| Current allowance | Requested amount | Result                       |
|-------------------|------------------|------------------------------|
| non-zero          | different non‑zero | **REJECTED** (`AllowanceRaceRejected`) |

All other transitions remain allowed:

| Current allowance | Requested amount | Result            |
|-------------------|------------------|-------------------|
| 0                 | any              | allowed (set)     |
| non-zero          | 0                | allowed (clear)   |
| non-zero          | same non‑zero    | allowed (no‑op)   |

This matches the standard mitigation pattern used by OpenZeppelin and other
major token frameworks.

### New functions: `increase_allowance` and `decrease_allowance`

To safely adjust an existing non-zero allowance without the race window, use:

- **`increase_allowance(from, spender, add_amount, expiration_ledger)`** —
  Reads the current allowance, adds `add_amount` (with overflow protection),
  and writes the new total with the provided expiration ledger.

- **`decrease_allowance(from, spender, sub_amount, expiration_ledger)`** —
  Reads the current allowance, subtracts `sub_amount`. If `sub_amount >=`
  current allowance, the allowance is set to `0` (floor-at-zero semantics).

Both functions:
- Require `from.require_auth()` (same as `approve`).
- Reject negative amounts.
- Emit an `ApproveEvent` on success.

> **Note:** Even the two-step pattern (`approve(from, spender, 0, …)` followed
> by `approve(from, spender, new_amount, …)`) has a (much smaller) race window
> between the zeroing and the re-setting.  The recommended migration is to use
> `increase_allowance` / `decrease_allowance` instead.

## Migration Guide

### Before (vulnerable)

```diff
- contract.approve({ from: alice, spender: bob, amount: 50 });
```

### After (safe — use increase/decrease)

```diff
+ // If changing from an existing non-zero allowance:
+ contract.increase_allowance({ from: alice, spender: bob, add_amount: 30, expiration_ledger });
+ // or
+ contract.decrease_allowance({ from: alice, spender: bob, sub_amount: 20, expiration_ledger });
```

### If you must use `approve` directly

When setting an allowance for the first time or clearing an existing one:

```javascript
// From zero (initial approval):
contract.approve({ from: alice, spender: bob, amount: 100, expiration_ledger });

// Clearing to zero:
contract.approve({ from: alice, spender: bob, amount: 0, expiration_ledger: 0 });
```

## Error Codes

| Code | Name                      | Description                                         |
|------|---------------------------|-----------------------------------------------------|
| 7    | `AllowanceRaceRejected`   | Non-zero-to-different-non-zero transition rejected  |
| 6    | `Overflow`                | Allowance overflow (increase exceeds i128::MAX)     |
| 9    | `NegativeAllowance`       | Negative amount passed to increase/decrease         |

## SEP-41 Compliance

The `approve` function retains the exact signature mandated by SEP-41
(Soroban Token Interface):

```rust
fn approve(env: Env, from: Address, spender: Address, amount: i128, expiration_ledger: u32);
```

The custom `increase_allowance` and `decrease_allowance` functions are
non-standard extensions and must be called via a custom client or direct
contract invocation.
