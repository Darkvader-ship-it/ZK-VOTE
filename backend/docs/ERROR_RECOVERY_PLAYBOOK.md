# Backend Error Recovery Playbook & Automated Remediation

This playbook outlines automated remediation, classification criteria, escalation workflows, and MTTR tracking for production backend errors.

---

## 🛠 Error Classification & Automated Remediation Matrix

| Error Type | Detection Criteria / Pattern | Automated Remediation Action | Success Indicator |
|---|---|---|---|
| **RPC Connectivity** | Health check timeout or connection refused | Automatically switches to next backup RPC endpoint in pool | RPC request succeeds on new endpoint |
| **RPC Rate Limited** | HTTP 429 response or `rate limit` message | Exponentially back off polling frequency (up to 30s) | Subsequent RPC calls succeed without 429 |
| **SQLite Locked** | `SQLITE_BUSY` error code or `database is locked` | Immediate retries with exponential backoff delay (100ms - 2000ms) | Transaction completes successfully |
| **SQLite Corrupt** | `SQLITE_CORRUPT` or `malformed` image | Triggers automated restore from litestream / S3 backup | Database integrity check returns OK |
| **Pinata / IPFS Down** | Timeout or 5xx response from Pinata API | Queues upload payloads in retry queue | Upload succeeds when service recovers |
| **Memory Exhaustion** | Heap memory threshold breach or near OOM | Triggers forced garbage collection or graceful worker restart | Memory usage drops below safe threshold |
| **Sequence Mismatch** | `tx_bad_seq` error from Soroban transaction | Re-fetches latest account sequence number from Stellar RPC | Transaction re-submission succeeds |
| **Service Crash** | Supervisor detects background worker termination | Supervisor automatically restarts crashed worker service | Worker health check reports OK |

---

## 🚨 Escalation Rules

1. **Level 1 (`AUTO_REMEDIATE`)**: Automatically executed on first 1-2 occurrences of error type.
2. **Level 2 (`ALERT`)**: Triggered after 3 consecutive failure occurrences. Raises warning logs and triggers PagerDuty / Slack alerts.
3. **Level 3 (`PAGE`)**: Triggered after 5+ consecutive failure occurrences or critical database corruption restore failures. Pages active operator on-call.

---

## 📊 Endpoints & Metrics

- **Remediation History Endpoint**: `GET /remediation/history`
  - Returns recent remediation actions, success status, and MTTR metrics.
- **Prometheus MTTR Metric**: `zkvote_remediation_mttr_seconds{error_type="..."}`
- **Prometheus Actions Counter**: `zkvote_remediation_actions_total{error_type="...", status="...", escalation="..."}`
