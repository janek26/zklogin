# Guided setup and verification

This project is intentionally a testnet-only research POC. Do not use it with
valuable assets. The active browser temporary key is a full Kernel root signer
until its 24-hour expiry.

## 1. Install the required tools

Use Node `22.23.1` (`.nvmrc`) and pnpm `11.12.0`.

```sh
corepack enable
corepack prepare pnpm@11.12.0 --activate
pnpm install --frozen-lockfile
pnpm setup:check
```

The normal test command compiles the actual Solidity validator source with solc
0.8.30, deploys it to an in-memory Base Sepolia-chain-ID EVM, and executes the
authorization cases. For the local Shanghai EVM only, its test runner uses a
byte-for-byte equivalent EIP-191 helper in place of unrelated Cancun-only
OpenZeppelin helper code; the production contract source and pinned dependency
remain unchanged. Foundry is additionally recommended for its Solidity test
suite and deployment script.

```sh
cd contracts
forge install foundry-rs/forge-std@v1.9.7 OpenZeppelin/openzeppelin-contracts@v5.6.1
forge fmt --check
forge build
forge test
cd ..
```

If you have Docker but do not want a local Foundry install, run the equivalent
containerized gate from the repository root:

```sh
pnpm test:contracts:docker
```

## 2. Create external testnet configuration

1. Create one **Google Web OAuth client**. Add `http://localhost:5173` to its
   authorised JavaScript origins. Do not create or put a client secret in this
   project.
2. Create a **Base Sepolia ZeroDev** project. Enable a low-budget sponsorship
   policy that permits the high verification-gas activation operation.
3. Copy `.env.example` to `apps/web/.env.local` and fill only its three public
   values: the Google client ID, ZeroDev project ID, and Base Sepolia RPC URL.
4. Keep `DEPLOYER_PRIVATE_KEY` only in your terminal environment for the next
   step. It must never appear in `.env.local`, a Vite variable, source control,
   or browser storage.

## 3. Freeze a deployment generation

Run these exactly once per generation, immediately before deployment:

```sh
pnpm snapshot:jwks
GOOGLE_CLIENT_ID='your-client.apps.googleusercontent.com' pnpm app-id
```

Record the output app ID and the snapshot root. Commit the complete snapshot;
do not refresh it automatically. Any Google key rotation outside this snapshot
intentionally stops login with `JWK_SNAPSHOT_MISS`.

Confirm code at the pinned verifier and Kernel addresses, then deploy:

```sh
cd contracts
export BASE_SEPOLIA_RPC_URL='https://sepolia.base.org'
export ULTRA_VERIFIER_ADDRESS='0xD37D6e4e41Be1F05AfDF653777848Ee4Fff8FBc9'
export GOOGLE_JWK_ROOT='0x...'
export APP_ID='0x...'
export DEPLOYER_PRIVATE_KEY='0x...'
forge script script/Deploy.s.sol:Deploy --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast
```

Update the committed `apps/web/src/generated/deployment.json` with the
validator address, verifier address, root, app ID, and code hashes. Increase
`generation` to a new integer; never edit an already-used generation in place.
Then verify the deployment:

```sh
BASE_SEPOLIA_RPC_URL="$BASE_SEPOLIA_RPC_URL" pnpm verify:deployment
```

## 4. Verify and run locally

```sh
pnpm verify
pnpm --dir apps/web dev
```

Open `http://localhost:5173` in a fresh modern browser. The expected flow is:
one Google interaction → `PROVING` in a Web Worker → `ACTIVATING` → `READY`.
Fund the displayed counterfactual Kernel address with Base Sepolia ETH, then
send a small test amount to an EOA.

## 5. Release gates

Before a demo, pass all of these:

- `pnpm verify` and either `pnpm test:contracts:foundry` or
  `pnpm test:contracts:docker`.
- `pnpm verify:deployment` against the final Base Sepolia generation.
- A real fresh Google token, browser-local proof, sponsored activation, and
  native transfer on Base Sepolia.
- A same-tab reload before expiry; a new-tab login that derives the same
  Kernel address; a JWK snapshot-miss test; and a session-expiry test.
- Browser Network inspection showing no JWT, witness, proof, `sub`, or
  temporary private key leaves the browser except the Google callback and
  main-thread-to-local-Worker message.

Use the headers in `deployment-headers.example` for the final HTTPS host.
