# Contracts

The on-chain component of the zkLogin native wallet POC.

## What's here

- **`ZkLoginKernelValidator.sol`** — a ZeroDev Kernel v3.3 secondary validator.
  Verifies Google zkLogin proofs, activates ephemeral session keys, and
  authorises UserOperations signed by those keys. Supports two signature modes:
  proof mode (mode `0x00`) for initial activation and session mode (`0x01`)
  for subsequent operations.
- **`UltraVerifier.sol`** — the Noir Groth16 verifier for the zkLogin circuit,
  sourced from `@shield-labs/zklogin-contracts@0.5.0`. Verifies browser-generated
  ZK proofs on-chain.

## Test

Run the Node-based contract integration suite from the repo root:

```sh
pnpm test:contracts
```

It compiles the validator with solc 0.8.30, deploys to an in-memory EVM, and
executes 16 protocol assertions covering proof validation, Merkle/JWK
enforcement, nonce binding, exact activation matching, session signatures,
expiry, ERC-1271, and lifecycle.

### Foundry suite

```sh
cd contracts
forge install foundry-rs/forge-std@v1.9.7 OpenZeppelin/openzeppelin-contracts@v5.6.1
forge fmt --check
forge build
forge test
```

Or with Docker: `pnpm test:contracts:docker` from the repo root.

## Deploy

The deploy script reads these environment variables:

| Variable | Description |
|----------|-------------|
| `DEPLOYER_PRIVATE_KEY` | EOA private key (never committed) |
| `ULTRA_VERIFIER_ADDRESS` | Deployed UltraVerifier address |
| `GOOGLE_JWK_ROOT` | Merkle root from JWK snapshot |
| `APP_ID` | Derived Google OAuth app identifier |

```sh
forge script Deploy --rpc-url <rpc> --broadcast
```

See [SETUP.md](../SETUP.md) for the full deployment guide.
