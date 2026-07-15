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

This project's own code (everything under `apps/web/src/`, `contracts/src/`,
`scripts/`, and `.github/`) is licensed under the **MIT License** — see
[LICENSE](LICENSE).

### Dependency licenses

| Package | License |
|---|---|
| `@react-oauth/google` | MIT |
| `@shield-labs/zklogin` | MIT (registry; no LICENSE file in repo) |
| `@shield-labs/zklogin-contracts` | MIT (registry; no LICENSE file in repo) |
| `@zerodev/sdk` | MIT |
| `@noir-lang/acvm_js` | MIT |
| `@noir-lang/noirc_abi` | MIT OR Apache-2.0 |
| `@openzeppelin/contracts` | MIT |
| `@openzeppelin/merkle-tree` | MIT |
| `jose` | MIT |
| `react` / `react-dom` | MIT |
| `viem` | MIT |
| `@vitejs/plugin-react` | MIT |
| `typescript` | Apache-2.0 |
| `vite` | MIT |
| `vitest` | MIT |
| `ethers` | MIT |
| `ganache` | MIT |
| `playwright` | Apache-2.0 |
| `solc` | MIT |
| `@aztec/bb.js` | MIT |

Shield Labs packages (`@shield-labs/zklogin`, `@shield-labs/zklogin-contracts`)
are listed as MIT on the npm registry but do not include a `LICENSE` file in
their repository. All other dependencies carry unambiguous open-source licenses.
