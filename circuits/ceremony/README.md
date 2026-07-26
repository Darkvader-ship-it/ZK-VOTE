# MPC Ceremony Scripts

This directory contains scripts for running a Multi-Party Computation (MPC) trusted setup ceremony for the ZK-VOTE circuits.

## Overview

The MPC ceremony generates trusted parameters for Groth16 zero-knowledge proofs. At least 20 independent contributors are required for production security.

## Components

### Coordinator Server (`coordinator.js`)

Manages the ceremony queue, verifies contributions, and maintains the transcript.

### Contributor Client (`contribute.js`)

Allows participants to download parameters, generate their contribution, and upload results.

### Verification Tool (`verify-ceremony.js`)

Verifies the complete ceremony transcript and extracts final parameters.

### Random Beacon (`random-beacon.js`)

Implements final contribution using Bitcoin block hash as randomness.

## Quick Start

### For Coordinator

```bash
# Install dependencies
npm install

# Start coordinator server
npm run coordinator

# Server runs on http://localhost:3000
# Contributors connect to this endpoint
```

### For Contributors

```bash
# Install dependencies
npm install

# Download current parameters from coordinator
npm run contribute:download -- --coordinator http://coordinator-url

# Generate your contribution
# This will use /dev/urandom for entropy
npm run contribute:generate

# Upload contribution to coordinator
npm run contribute:upload -- --coordinator http://coordinator-url
```

### Verification

```bash
# Verify complete ceremony after all contributions
npm run verify:ceremony

# Extract final parameters for production use
npm run verify:extract
```

## Ceremony Workflow

1. **Setup Phase**
   - Coordinator starts server
   - Announces ceremony start
   - Publishes initial parameters

2. **Contribution Phase**
   - Contributors join queue
   - Each contributor:
     - Downloads current params
     - Generates contribution locally
     - Uploads new params + proof
     - Coordinator verifies and advances queue

3. **Random Beacon Phase**
   - Announce target Bitcoin block height
   - Wait for block confirmation
   - Apply block hash as final entropy
   - Publish final parameters

4. **Verification Phase**
   - Independent verifiers check transcript
   - Extract and test final parameters
   - Update contracts with new VK

## File Structure

```
ceremony/
├── README.md                    # This file
├── package.json                 # Dependencies and scripts
├── coordinator.js               # Ceremony coordination server
├── contribute.js                # Contributor client
├── verify-ceremony.js           # Verification tool
├── random-beacon.js             # Bitcoin beacon integration
├── config.json                  # Ceremony configuration
└── transcript/                  # Ceremony transcript (gitignored)
    ├── phase1_initial.ptau
    ├── phase1_contributions/
    ├── phase2_initial.zkey
    ├── phase2_contributions/
    └── ceremony_transcript.json
```

## Configuration

Edit `config.json` to customize:

```json
{
  "circuit": "vote",
  "minContributors": 20,
  "contributionTimeout": 43200,
  "phase1PtauPower": 16,
  "bitcoinBeaconBlock": null
}
```

## Security Notes

### For Contributors

1. **Use secure randomness**: The script uses `/dev/urandom` by default
2. **Verify coordinator**: Check coordinator's identity before contributing
3. **Delete files**: Remove all ceremony files after contribution
4. **Document**: Note your entropy source in contribution metadata
5. **Sign**: Optionally sign your contribution with PGP

### For Coordinators

1. **Public server**: Run coordinator on publicly accessible server
2. **Backup**: Regularly backup transcript directory
3. **Monitor**: Watch for contribution timeouts and errors
4. **Verify**: Verify each contribution before advancing queue
5. **Publish**: Make transcript publicly available (IPFS recommended)

## Dependencies

```json
{
  "snarkjs": "^0.7.0",
  "express": "^4.18.0",
  "bitcoin-core": "^4.0.0",
  "chalk": "^5.0.0"
}
```

## Ceremony Timeline Example

Assuming 20 contributors with 12-hour slots:

- Phase 1: 10 days (20 × 12h)
- Verification: 1 day
- Phase 2: 10 days (20 × 12h)
- Random Beacon: 1 day
- Final Verification: 2 days

**Total**: ~24 days

## Testing

Run ceremony with test parameters (fast, not secure):

```bash
# Test with 3 contributors
npm run test:ceremony -- --contributors 3
```

## Troubleshooting

### "Verification failed"

- Contributor may have used incorrect previous parameters
- Check contribution proof file
- Contributor should retry

### "Contribution timeout"

- Contributor didn't submit within time limit
- Slot is reassigned to next in queue

### "Out of memory"

- Increase Node.js heap: `NODE_OPTIONS=--max-old-space-size=8192`
- Minimum 8GB RAM required

## Production Checklist

Before production ceremony:

- [ ] Test complete ceremony flow with 3+ testers
- [ ] Announce ceremony schedule publicly
- [ ] Recruit 20+ diverse contributors
- [ ] Set up monitoring and backup
- [ ] Prepare communication channels (Discord/Telegram)
- [ ] Document coordinator's identity verification
- [ ] Set up IPFS node for transcript publishing
- [ ] Prepare Bitcoin node for random beacon

After ceremony:

- [ ] Verify transcript with independent tool
- [ ] Publish transcript to IPFS
- [ ] Update contracts with new verification key
- [ ] Archive old keys
- [ ] Document all participants
- [ ] Thank contributors publicly

## References

- [Trusted Setup Ceremony Guide](../../docs/trusted-setup-ceremony.md)
- [snarkjs Ceremony Tools](https://github.com/iden3/snarkjs#7-prepare-phase-2)
- [Tornado Cash Ceremony](https://tornado-cash.medium.com/the-biggest-trusted-setup-ceremony-in-the-world-9f1b57d62e16)

## Support

For questions during the ceremony:

- GitHub Issues: github.com/ZK-VOTE/ZK-VOTE/issues
- Discord: [server link]
- Email: ceremony@zkvote.io
