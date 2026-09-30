# SQL Injection Security Implementation

## Overview
This document outlines the comprehensive security measures implemented to prevent SQL injection attacks in the ZKVote backend database layer.

## Security Measures Implemented

### 1. Input Validation & Allowlisting

#### DAO ID Validation
- **Function**: `validateDaoId(daoId: number)`
- **Protection**: Ensures DAO IDs are positive integers ≤ 999,999
- **Prevents**: Table name injection through `events_${daoId}` patterns

#### Event Type Allowlisting  
- **Constant**: `ALLOWED_EVENT_TYPES` Set
- **Protection**: Only permits predefined event types
- **Prevents**: Type-based SQL injection and data corruption

#### Column Name Allowlisting
- **Constant**: `ALLOWED_ORDER_COLUMNS` Set
- **Protection**: Restricts ORDER BY columns to safe, predefined set
- **Prevents**: ORDER BY injection attacks

### 2. Parameterized Queries

All database interactions use prepared statements with parameterized queries:

```typescript
// ✅ SECURE: Parameterized query
const query = `SELECT * FROM ${tableName} WHERE type = ? AND verified = ?`;
database.prepare(query).all(eventType, verified);

// ❌ VULNERABLE: String concatenation  
const query = `SELECT * FROM ${tableName} WHERE type = '${eventType}'`;
```

### 3. Query Logging & Monitoring

#### Secure Query Logging
- **Function**: `logQuery(query, params, operation)`
- **Features**: 
  - Logs all SQL operations
  - Redacts sensitive parameter values
  - Tracks query patterns for anomaly detection

#### Parameter Redaction
```typescript
// Parameters longer than 8 chars are redacted: "abcd****[REDACTED]"
const redactedParams = params.map(param => 
  typeof param === 'string' && param.length > 8 
    ? `${param.slice(0, 4)}****[REDACTED]` 
    : param
);
```

### 4. Enhanced Database Configuration

#### Strict Mode (Better-SQLite3 v8+)
```typescript
try {
  database.pragma("strict = ON");
} catch (err) {
  log("warn", "sqlite_strict_mode_unavailable");
}
```

#### Security Pragmas
```typescript
database.pragma("journal_mode = WAL");
database.pragma("foreign_keys = ON");
```

### 5. ESLint Security Rules

The ESLint configuration includes custom rules to detect SQL injection patterns:

```javascript
'no-restricted-syntax': [
  'error',
  {
    selector: 'TemplateLiteral[expressions.length>0][quasis.0.value.raw*="SELECT"]',
    message: 'Potential SQL injection: Use parameterized queries instead.'
  }
  // ... additional patterns for INSERT, UPDATE, DELETE, ORDER BY
]
```

### 6. Comprehensive Testing

#### SQL Injection Test Suite
- **File**: `backend/test/sql-injection.test.js`
- **Coverage**:
  - DAO ID validation attacks
  - Event type injection attempts
  - ORDER BY injection patterns
  - Parameter boundary testing
  - JSON migration security
  - Transaction hash validation

#### Test Examples
```javascript
test('should reject DAO ID injection attempts', () => {
  const maliciousIds = [
    '1; DROP TABLE events_1; --',
    '1 UNION SELECT * FROM sqlite_master',
    '1\' OR \'1\'=\'1'
  ];

  maliciousIds.forEach(maliciousId => {
    expect(() => {
      db.addEvent({ daoId: maliciousId, type: 'dao_create', data: {} });
    }).toThrow();
  });
});
```

## Security Functions Reference

### Core Validation Functions

| Function | Purpose | Returns |
|----------|---------|---------|
| `validateDaoId(daoId)` | Validates DAO ID format | `number` |
| `validateEventTypes(types)` | Validates event types against allowlist | `string[]` |
| `validateOrderBy(column, direction)` | Validates ORDER BY parameters | `{column, direction}` |
| `logQuery(query, params, operation)` | Logs SQL queries securely | `void` |

### Allowlists

#### Event Types
```typescript
const ALLOWED_EVENT_TYPES = new Set([
  'dao_create', 'admin_transfer', 'member_added', 'member_revoked',
  'member_left', 'tree_init', 'voter_registered', 'voter_removed',
  'voter_reinstated', 'vk_updated', 'proposal_created', 
  'proposal_closed', 'proposal_archived', 'vote_cast'
]);
```

#### Order Columns
```typescript
const ALLOWED_ORDER_COLUMNS = new Set([
  'id', 'timestamp', 'ledger', 'type', 'verified', 'created_at'
]);
```

## Attack Vectors Mitigated

1. **Table Name Injection**: Via DAO ID validation
2. **Column Name Injection**: Via ORDER BY allowlisting  
3. **Event Type Injection**: Via event type allowlisting
4. **Parameter Injection**: Via parameterized queries
5. **UNION Attacks**: Via input validation and prepared statements
6. **Boolean Injection**: Via type checking and validation
7. **Time-Based Injection**: Via query logging and monitoring
8. **Second-Order Injection**: Via JSON migration input validation

## Deployment Checklist

- [ ] All functions use `partitionTableName()` for table name generation
- [ ] All queries use parameterized statements (`?` placeholders)
- [ ] Event types validated against `ALLOWED_EVENT_TYPES`
- [ ] ORDER BY columns validated against `ALLOWED_ORDER_COLUMNS` 
- [ ] Query logging enabled for all database operations
- [ ] ESLint rules configured and passing
- [ ] SQL injection test suite passing
- [ ] Better-SQLite3 strict mode enabled (if available)

## Monitoring & Alerting

### Query Pattern Monitoring
Monitor logs for:
- Unusual query patterns
- Failed validation attempts  
- High parameter redaction rates
- Repeated injection attempt signatures

### Alert Triggers
- Multiple validation failures from same source
- Queries with suspicious parameter patterns
- Attempts to access non-existent tables
- Unusual ORDER BY column requests

## Future Enhancements

1. **Query Complexity Analysis**: Monitor and limit query complexity
2. **Rate Limiting**: Per-IP rate limiting for database operations  
3. **Anomaly Detection**: ML-based detection of unusual query patterns
4. **Query Whitelisting**: Additional layer of approved query patterns
5. **Database Firewall**: External database firewall integration

## References

- [OWASP SQL Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html)
- [Better-SQLite3 Security Best Practices](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#security)
- [SQLite Security Guidelines](https://sqlite.org/security.html)