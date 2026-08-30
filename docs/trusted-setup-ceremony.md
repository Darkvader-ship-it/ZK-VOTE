# Trusted Setup Ceremony - Multi-Party Computation

## Overview

This document describes the Multi-Party Computation (MPC) ceremony for generating trusted parameters for the ZK-VOTE Groth16 circuits. The security assumption of Groth16 is "1-of-N" — the system is secure if at least one ceremony participant destroyed their toxic waste.

## Ceremony Structure

The ceremony consists of two phases:

1. **Phase 1**: Powers of Tau - generates universal parameters
2. **Phase 2**: Circuit-specific - generates parameters for vote.circom

## Security Properties

- **Minimum Contributors**: 20 independent participants
- **Randomness Source**: Each contributor must use cryptographically secure randomness
- **Verification**: Each contribution is publicly verifiable
- **Transcript**: All contributions and verification proofs are published
- **Final Contribution**: Uses random beacon (future Bitcoin block hash)

## Ceremony Coordination

### Server Requirements

The coordination server must:

- Accept contribution submissions
- Verify each contribution
- Maintain contribution queue
- Publish intermediate results
- Store complete transcript

### Contribution Process

1. Contributor receives current parameters
2. Contributor applies their randomness
3. Contributor uploads new parameters + proof
4. Server verifies the contribution
5. Server publishes to transcript

## Participant Requirements

### Technical Requirements

- Secure computing environment (air-gapped preferred)
- Min 8GB RAM for parameter generation
- ~50GB disk space for intermediate files
- Ability to run snarkjs CLI

### Security Requirements

- Generate randomness from hardware RNG or /dev/urandom
- Document entropy source
- Destroy all local copies after contribution
- Sign contribution with PGP key

## Implementation

### Coordinator Server

```bash
# Start MPC coordinator
cd circuits/ceremony
npm run coordinator
```

### Contributor Client

```bash
# Download current parameters
npm run download-params

# Generate contribution
npm run contribute -- --entropy-file /dev/urandom

# Upload contribution
npm run upload-contribution
```

## Verification

After ceremony completion:

```bash
# Verify full transcript
npm run verify-ceremony

# Extract final parameters
npm run extract-final-params
```

## Random Beacon

The final contribution uses a future Bitcoin block hash as randomness:

1. Announce target block height (current + 6 blocks)
2. Wait for block to be mined
3. Use block hash as entropy for final contribution
4. Publish proof linking block hash to final parameters

## Ceremony Timeline

| Phase              | Duration  | Activity                                  |
| ------------------ | --------- | ----------------------------------------- |
| Setup              | 1 week    | Test infrastructure, recruit participants |
| Phase 1            | 2-3 weeks | Powers of Tau with 20+ contributors       |
| Verification       | 3 days    | Verify Phase 1 transcript                 |
| Phase 2            | 2 weeks   | Circuit-specific with 20+ contributors    |
| Random Beacon      | 1 day     | Final contribution using Bitcoin block    |
| Final Verification | 3 days    | Verify complete ceremony                  |
| Deployment         | 1 day     | Update contracts with new VK              |

## Participant Coordination

### Communication Channels

- Public announcements: GitHub Discussions
- Coordination: Discord server
- Verification: ceremony.zkvote.io

### Contribution Schedule

- Phase 1: Rolling queue, 12-hour slots
- Phase 2: Rolling queue, 12-hour slots
- Missed slots: Reassigned after timeout

## Transparency

All ceremony data is published:

- Full transcript on IPFS
- Contribution hashes on-chain
- Participant signatures
- Verification proofs

## Post-Ceremony

After ceremony:

1. Update verification key in contracts
2. Archive old keys with version number
3. Update circuit build scripts
4. Document ceremony participants
5. Publish final transcript

## Migration Path

For production deployment:

1. Complete MPC ceremony
2. Test with ceremony-generated keys
3. Deploy with upgrade mechanism (#67)
4. Consider PLONK migration (#51) to eliminate trusted setup

## Resources

- snarkjs documentation: https://github.com/iden3/snarkjs
- Powers of Tau specification: https://eprint.iacr.org/2017/1050
- Groth16 paper: https://eprint.iacr.org/2016/260
- Example ceremony: Tornado Cash (2020)

## Security Considerations

### Attack Vectors

- **Coordinator compromise**: Mitigated by public verification
- **Contributor collusion**: Requires ALL contributors
- **MITM attacks**: Prevented by signed contributions
- **Parameter tampering**: Detected by verification proofs

### Best Practices

- Use air-gapped machines for contribution
- Multiple independent verifiers
- Diverse contributor backgrounds
- Public commitment to destroy secrets
- Document entropy sources

## Contact

For ceremony participation or questions:

- GitHub: github.com/ZK-VOTE/ZK-VOTE
- Discord: [server link]
- Email: ceremony@zkvote.io
