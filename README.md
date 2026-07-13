# zkLogin native wallet POC

Browser-only Google zkLogin proof, ZeroDev Kernel 0.3.3 / EntryPoint 0.7, and
Base Sepolia native transfers. This is unaudited, testnet-only research code.
The temporary browser key is a general Kernel root UserOperation signer while
active; "native only" is a UI constraint, not an on-chain policy.

## Prerequisites

- Node 22.23.1 and pnpm 11.12.0
- Foundry (for Solidity build/test/deploy)
- A fixed Google Web OAuth client, a Base Sepolia ZeroDev project with bounded
  sponsorship, and a funded deployment key held outside the repository
- Written license clarification from Shield Labs before copying/modifying or
  redistributing Shield source

## Generate one immutable deployment generation

1. `pnpm install`
2. `pnpm snapshot:jwks` and commit the populated snapshot.
3. `GOOGLE_CLIENT_ID=... pnpm app-id`; record the output.
4. Populate the public values in `apps/web/.env.local` using `.env.example`.
5. Check the pinned verifier/infrastructure then deploy the validator using
   `contracts/script/Deploy.s.sol` with a non-browser deployer key.
6. Update `src/generated/deployment.json` exactly once, then run
   `pnpm verify:deployment`.
7. `pnpm typecheck && pnpm test && pnpm build && pnpm test:contracts`.

`jwk-snapshot.json` and `deployment.json` are intentionally checked-in
templates until steps 2–6 have been completed. The application refuses to boot
with template values.

## Development

`pnpm --dir apps/web dev` starts Vite. Register `http://localhost:5173` in the
Google OAuth client. Production must be HTTPS with the CSP/COOP headers in the
implementation guide. Never log or persist JWTs, proofs, witnesses, or private
keys outside same-tab `sessionStorage` for the active temporary key.
