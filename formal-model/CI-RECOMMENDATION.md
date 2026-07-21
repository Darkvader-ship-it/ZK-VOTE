# CI Recommendation: Formal Method Toolchain for ZK-VOTE

## Recommended Toolchain: TLA+ with TLC + Apalache

### Why TLA+?

| Requirement | TLA+ | Alloy | Coq/Lean | Why TLA+ wins |
|---|---|---|---|---|
| State-space coverage | Bounded MC (TLC) + symbolic (Apalache) | Bounded only | Interactive proof | TLC gives fast CI feedback; Apalache gives deeper symbolic coverage |
| Cross-contract interleavings | Native (concurrent actions) | Native | Manual encoding | TLA+ `Next` relation models all interleavings explicitly |
| FIFO queue semantics | Native sequences | Yes | Manual | Root history is a Seq with Tail/Append |
| Auth delegation patterns | Easy (boolean guards) | Easy | Tedious | TLA+ boolean guards map 1:1 to require_auth() |
| Learning curve | Moderate | Low | High | TLA+ is the sweet spot for this problem |
| CI integration | TLC CLI (Java) | Lightweight | Heavy | TLC runs headless, outputs XML/JSON |

## CI Integration

### Option 1: TLC (Bounded Model Checking) — RECOMMENDED for CI

**Setup:**
```yaml
# .github/workflows/formal-model.yml
name: Formal Model Check
on: [pull_request]
jobs:
  tlc:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run TLC model checker
        uses: aerben/tlaplus-github-action@v1
        with:
          spec: formal-model/ZKVote.tla
          config: formal-model/ZKVote.cfg
          tlc_params: -workers auto -deadlock -depth 20
```

**Estimated compute cost:**
- Small model (2 DAOs, 3 members, 2 proposals, depth 20): ~30-60 seconds, < 1 GB RAM
- Medium model (3 DAOs, 5 members, 3 proposals, depth 30): ~5-10 minutes, ~4 GB RAM
- Full model (5 DAOs, 10 members, 5 proposals, depth 50): ~2-4 hours, ~16 GB RAM

### Option 2: Apalache (Symbolic Model Checker)

For deeper symbolic coverage without state explosion:

```yaml
# .github/workflows/apalache.yml
name: Apalache Symbolic Check
on: [pull_request]
jobs:
  apalache:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Apalache type check
        uses: apalache-tla/apalache@v0.44
        with:
          args: typecheck formal-model/ZKVote.tla
      - name: Run Apalache model check
        uses: apalache-tla/apalache@v0.44
        with:
          args: mc --invariant=Invariants --length=20 formal-model/ZKVote.tla
```

**Estimated compute cost per model-check:**
- TLC bounded (depth 20, 2 DAOs, 3 members): ~30s, 512MB RAM
- TLC bounded (depth 30, 3 DAOs, 5 members): ~5min, 2GB RAM
- Apalache symbolic (unbounded): ~10min, 4GB RAM
- Total CI cost: < $0.05 per run on standard GitHub runners

### Option 3: Alloy (Lightweight Alternative)

For teams without TLA+ expertise, Alloy provides a gentler learning curve:

```alloy
// Alloy model would capture the same state machine with
// signatures for Dao, Proposal, Member, Nullifier
// and predicates for each invariant
```

**Tradeoff**: Alloy's bounded scope (typically 3-10 instances) finds bugs but cannot prove unbounded correctness. TLA+/TLC provides stronger guarantees.

## Recommendation

| Phase | Tool | Scope | CI Cost |
|-------|------|-------|---------|
| PR-level smoke check | TLC (depth 20, small scope) | 30s, 512MB | $0.01 |
| Nightly deep check | TLC (depth 50, medium scope) | 10min, 4GB | $0.05 |
| Weekly symbolic | Apalache (unbounded) | 30min, 8GB | $0.20 |
| Per-release | Manual review of counterexample traces | 1-2hrs | N/A |

**Total CI cost per PR**: < $0.05 on standard GitHub runners.
