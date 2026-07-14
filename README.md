# zkLogin native wallet

Browser-only Google zkLogin proof, ZeroDev Kernel 0.3.3 / EntryPoint 0.7, and
MegaETH testnet native transfers.

**Unaudited research POC — testnet only.**

## How it works

1. Sign in with Google — your identity is verified via OAuth
2. A zero-knowledge proof is generated entirely in your browser (Web Worker,
   Noir/Aztec backend). Nothing leaves the tab.
3. The proof activates an ephemeral session key (24h) on a Kernel smart account
4. Transfers are signed by the session key and sponsored via ZeroDev paymaster

The active browser session key is a full Kernel root signer during its 24-hour
window. "Native only" is a UI constraint, not an on-chain policy.

## Quick start

- Node 22.23.1 and pnpm 11.12.0
- Foundry for Solidity build, test, and deploy
- A Google Web OAuth client and a ZeroDev project with sponsorship for
  MegaETH testnet (chain 6343)
- A deployer key held outside the repository

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm --dir apps/web dev
```

See [SETUP.md](SETUP.md) for the full guided setup, deployment, and release
gates.

## Structure

```
apps/web/src/
  App.tsx                     state, effects, layout
  config.ts                   chain + deployment config
  aa/                         account abstraction (Kernel client, validator)
  auth/                       prove, nonce, JWT validation, Web Worker
  components/                 onboarding, wallet view, icons
  lib/                        types, reducer, utils, session
  generated/                  deployment JSON, JWK snapshot
contracts/
  src/                        ZkLoginKernelValidator, UltraVerifier
  script/                     Foundry deploy script
  test/                       Foundry test suite
```

## Verify

```sh
pnpm verify          # typecheck, vitest, build, contract integration (16 assertions)
pnpm verify:deployment  # on-chain contract audit
```

## License

Written license clarification from Shield Labs required before copying,
modifying, or redistributing Shield source (`@shield-labs/zklogin`,
`@shield-labs/zklogin-contracts`).
