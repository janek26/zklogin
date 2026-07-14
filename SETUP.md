# Setup

A testnet-only research POC. Do not use with valuable assets. The active
browser session key is a full Kernel root signer during its 24-hour window.

## Prerequisites

- **Node** 22.23.1 (`.nvmrc`) and **pnpm** 11.12.0
- **Foundry** for Solidity build, test, and deploy (or Docker as fallback)

```sh
pnpm install --frozen-lockfile
pnpm setup:check
```

### Foundry (recommended)

```sh
cd contracts
forge install foundry-rs/forge-std@v1.9.7 OpenZeppelin/openzeppelin-contracts@v5.6.1
forge fmt --check
forge build
forge test
```

### Docker (fallback)

```sh
pnpm test:contracts:docker
```

## External services

1. **Google Web OAuth client.** Add `http://localhost:5173` to authorised
   JavaScript origins. No client secret needed.
2. **ZeroDev project** with sponsorship enabled for MegaETH testnet
   (chain 6343). Configure a gas policy that covers the high-gas activation
   UserOp (~800k gas).

Copy `.env.example` to `apps/web/.env.local`:

```sh
VITE_GOOGLE_CLIENT_ID=…apps.googleusercontent.com
VITE_ZERODEV_PROJECT_ID=…
VITE_MEGAETH_TESTNET_RPC_URL=https://carrot.megaeth.com/rpc
```

## Deploy

The ZeroDev Kernel v3.3 contracts and EntryPoint 0.7 are already deployed on
MegaETH testnet at deterministic addresses. You only need to deploy two
contracts: the UltraVerifier (Noir Groth16 verifier from Shield Labs) and the
ZkLoginKernelValidator.

### 1. Freeze a JWK snapshot

```sh
pnpm snapshot:jwks
GOOGLE_CLIENT_ID='your-client.apps.googleusercontent.com' pnpm app-id
```

Commit the snapshot. Record the app ID. Any Google key rotation outside the
snapshot intentionally stops login with `JWK_SNAPSHOT_MISS`.

### 2. Deploy the UltraVerifier

The verifier source is at `contracts/src/UltraVerifier.sol` (copied from
`@shield-labs/zklogin-contracts`). Deploy with Foundry:

```sh
cd contracts
forge create --rpc-url https://carrot.megaeth.com/rpc \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  src/UltraVerifier.sol:UltraVerifier
```

### 3. Deploy the validator

```sh
ULTRA_VERIFIER_ADDRESS=<address from step 2> \
GOOGLE_JWK_ROOT=<root from snapshot> \
APP_ID=<app-id from step 1> \
DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" \
forge script Deploy --rpc-url https://carrot.megaeth.com/rpc --broadcast
```

### 4. Commit the deployment

Update `apps/web/src/generated/deployment-megaeth.json` with the new addresses
and runtime code hashes. Increment `generation`; never edit an already-used
generation in place.

Verify on-chain:

```sh
pnpm verify:deployment
```

## Run locally

```sh
pnpm verify
pnpm --dir apps/web dev
```

Open `http://localhost:5173`. The expected flow:

1. Sign in with Google
2. `PROVING` — ZK proof generated in a Web Worker, ~30–80s
3. `ACTIVATING` — smart account deployed and session key activated
4. `READY` — balance and send form appear

Fund the displayed counterfactual Kernel address with MegaETH testnet ETH
(from the [faucet](https://testnet.megaeth.com)), then send a test transfer.

## Release gates

- `pnpm verify` (typecheck, vitest, build, contract integration)
- `pnpm verify:deployment` against the final deployment generation
- Full flow: Google sign-in → proof → activation → native transfer
- Same-tab reload before session expiry
- New-tab login derives the same Kernel address
- JWK snapshot-miss test
- Session expiry test
- Network inspection: no JWT, witness, proof, `sub`, or temporary private key
  leaves the browser except the Google callback and Worker message

Use the headers in `deployment-headers.example` for production HTTPS hosting.
