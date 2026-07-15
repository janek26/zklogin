# Agent Guide — zkLogin Native Wallet POC

Quick reference for AI agents working on this repo. Full architecture: [`architecture.md`](architecture.md).

## One-liner

Browser-based ZK proof wallet. Google Sign-In (pure OAuth redirect) → local WASM proof generation (UltraPlonk) → ZeroDev Kernel v3.3 smart account on Megaeth testnet (chain 6343).

## Quick facts

| Thing | Value | Source |
|---|---|---|
| Chain | Megaeth testnet, chain ID 6343 | `apps/web/src/config.ts:35` |
| RPC | See `.env.local` / CI env | `VITE_MEGAETH_TESTNET_RPC_URL` |
| ZeroDev Project ID | See `.env.local` | `VITE_ZERODEV_PROJECT_ID` |
| Google Client ID | See `.env.local` | `VITE_GOOGLE_CLIENT_ID` |
| Production URL | See CI env | `VITE_REDIRECT_URL` |
| Preview URL pattern | `https://<branch>.zklogin-poc.pages.dev` | CI `deploy-preview` |
| Cloudflare IDs | See CI secrets | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID` |
| Proving timeout | 5 minutes | `apps/web/src/auth/prove.ts:14` |
| PreLogin TTL | 300 seconds | `apps/web/src/lib/session.ts:17` |
| Session max duration | 24 hours | `nonce.ts:35` + `ZkLoginKernelValidator.sol:57` |
| Proof (multithreaded) | ~7s warm, ~11s cold | `proof-enhancement-plans.md:9` |
| Proof (single-threaded) | ~47-67s | `proof-enhancement-plans.md:9` |

## Where everything lives

See [`architecture.md` §Repository layout](architecture.md#repository-layout) for the full tree. Key files by concern:

| Concern | Primary file(s) |
|---|---|
| OAuth flow | `apps/web/src/auth/googleOAuth.ts` |
| Session creation (nonce) | `apps/web/src/auth/nonce.ts` |
| JWT validation | `apps/web/src/auth/validateJwt.ts` |
| Proof orchestration | `apps/web/src/auth/prove.ts` |
| Proof WASM worker | `apps/web/src/auth/prover.worker.ts` |
| Session management | `apps/web/src/lib/session.ts` |
| Config (frozen) | `apps/web/src/config.ts` |
| AA client setup | `apps/web/src/aa/client.ts` |
| Kernel validator adapter | `apps/web/src/aa/zkLoginValidator.ts` |
| Root component + stage machine | `apps/web/src/App.tsx` |
| Sign-in UI | `apps/web/src/components/Onboarding.tsx` |
| Wallet UI | `apps/web/src/components/WalletView.tsx` |
| All styles | `apps/web/src/style.css` |
| Validator contract | `contracts/src/ZkLoginKernelValidator.sol` |
| UltraPlonk verifier | `contracts/src/UltraVerifier.sol` |
| Deployment JSON | `apps/web/src/generated/deployment-megaeth.json` |
| JWK snapshot | `apps/web/src/generated/jwk-snapshot.json` |
| HTTP headers (COOP/COEP) | `apps/web/public/_headers` |
| CI/CD | `.github/workflows/ci.yml` |
| Vite config (COI for dev) | `apps/web/vite.config.ts` |
| Env vars template | `apps/web/.env.example` |
| Proof acceleration plan | `proof-enhancement-plans.md` |
| Known gaps | `TODOS.md` |

## Constraints — MUST NOT break

1. **Proof generation stays client-side.** Never send JWT, nonce, witness, or session key to a server.
2. **Circuit + on-chain format frozen.** `@shield-labs/zklogin-contracts@0.5.0`, UltraPlonk, 67 public inputs, 2,144-byte proofs. See [`architecture.md` §Key invariants](architecture.md#key-invariants).
3. **`SharedArrayBuffer` required.** COOP+COEP headers are mandatory for multithreaded WASM. Without them proving is 5-7x slower.
4. **No cross-origin scripts.** The OAuth flow is a pure redirect (`response_type=id_token`). No Google GIS library, no `@react-oauth/google` runtime use (it's in deps but not used in the auth flow per the handoff — check current state before assuming).
5. **Config uses dot notation only.** `import.meta.env.VITE_FOO`, not `import.meta.env[name]`. Vite 8/Rolldown constraint. See `apps/web/src/config.ts:28`.
6. **`config` is frozen.** `Object.freeze()` at `config.ts:34`. Never mutate. Validated at import time.
7. **Exact activation callData.** `_isExactActivation` (`ZkLoginKernelValidator.sol:221`) enforces `keccak256` match. Proof-mode UserOps can only encode `activateSession` with exact params. See [`TODOS.md`](TODOS.md) for planned relaxation.

## Key patterns

### Storage keys
- `zklogin.prelogin.v1` → `PreLoginSession` (sessionStorage, TTL 300s)
- `zklogin.ready.v1` → `StoredReadySession` (sessionStorage, survives reloads)
- `zklogin.mobile-disclaimer` → `"1"` (sessionStorage, dismiss flag)

### Nonce binding
```
nonce = keccak256(SESSION_DOMAIN ‖ chainId ‖ validatorAddress ‖ appId ‖ sessionKey ‖ validUntil ‖ randomness)
```
Same derivation in browser (`nonce.ts:computeSessionNonce`) and on-chain (`ZkLoginKernelValidator.sol:sessionNonce`). Passed as Google OAuth `nonce` parameter. See [`architecture.md` §Auth flow](architecture.md#auth-flow--detailed).

### Signature modes
- **Mode `0x00`** (Proof): `0x00 ‖ abi.encode(ProofAuth + sessionSignature)`. For kernel deployment + activation.
- **Mode `0x01`** (Session): `0x01 ‖ ecdsa_signature`. For all subsequent UserOps.

Encoded in `zkLoginValidator.ts:encodeProofMode`/`encodeSessionMode`, decoded in `ZkLoginKernelValidator.sol:_validateProofMode`/`_validateSessionMode`.

### Stage machine
`App.tsx` uses `Stage` type: `PREPARING → GOOGLE_READY → PROVING → ACTIVATING → READY (↔ ERROR)`. Not a formal reducer — React `useState`. See [`architecture.md` §Stage machine](architecture.md#stage-machine).

## Build & test

```bash
pnpm install --frozen-lockfile    # pnpm 11.12.0, Node 22
pnpm typecheck                     # tsc --noEmit
pnpm test                          # vitest (validator encoding)
pnpm test:contracts                # Node solc+ganache integration (16 assertions)
pnpm build                         # tsc -b + vite build
pnpm verify                        # typecheck + test + build + test:contracts
```

### Foundry (contracts/)
```bash
cd contracts
forge build
forge test
forge fmt --check
```

Forge deps are git submodules. CI checks them out with `submodules: true`.

### Local dev
```bash
# In apps/web/:
pnpm dev                           # Vite dev server (no COI headers unless BENCH_COI=1)
BENCH_COI=1 pnpm dev               # With COOP/COEP for SharedArrayBuffer testing

# Or from root:
node scripts/serve-coi.mjs         # Standalone COI server at :8787
```

### Env vars (required)
```env
VITE_GOOGLE_CLIENT_ID=….apps.googleusercontent.com
VITE_ZERODEV_PROJECT_ID=<uuid>
VITE_MEGAETH_TESTNET_RPC_URL=<rpc-url>
VITE_REDIRECT_URL=https://your-domain.com    # or window.location.origin for previews
```

See `apps/web/.env.example` for the template.

## Deployment
### Production (push to main)
```bash
VITE_REDIRECT_URL=$YOUR_DOMAIN pnpm build
wrangler pages deploy apps/web/dist --project-name=zklogin-poc
```

### Preview (PR)
```bash
VITE_REDIRECT_URL=window.location.origin pnpm build
wrangler pages deploy apps/web/dist --project-name=zklogin-poc --branch=<name>
```

### Cache purge (manual)
```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"purge_everything":true}'
```

## Testing deployments

```bash
# COI header verification (WebKit + Chromium via Playwright)
node scripts/test-coi-webkit.mjs [URL]

# Proof benchmarks (Puppeteer)
node scripts/run-benchmark.mjs --runs=1
node scripts/run-benchmark.mjs --runs=1 --coi

# Deployment verification
node scripts/verify-deployment.mjs
```

## Dependencies (pinned)

| Package | Version | Why pinned |
|---|---|---|
| `@aztec/bb.js` | 0.65.2 | Later versions removed UltraPlonk interfaces |
| `@noir-lang/noir_js` | 1.0.0-beta.0 | Must match circuit toolchain |
| `@noir-lang/acvm_js` | 1.0.0-beta.0 | Must match circuit toolchain |
| `@shield-labs/zklogin` | 0.6.1 | ZK proof SDK |
| `@shield-labs/zklogin-contracts` | 0.5.0 | On-chain format (frozen) |
| `@zerodev/sdk` | 5.5.10 | Kernel v3.3 support |

All overrides in root `package.json:32-36`.

## JWK snapshot

Google's JWKS keys are frozen in `apps/web/src/generated/jwk-snapshot.json`. This avoids network fetches during proof generation. Keys rotate periodically — run `pnpm snapshot:jwks` to refresh, then redeploy. If a Google key rotates and the snapshot is stale, proofs will fail with `JWK_SNAPSHOT_MISS`.

The snapshot contains: Merkle tree over all keys (root = `googleJwkRoot`), limb decompositions for each key (for the Noir circuit), and pre-computed Merkle proofs (`jwkProof[]`).

## Google Cloud Console

For OAuth to work on a new origin:
1. Add it to **Authorized JavaScript Origins**
2. Add it to **Authorized Redirect URIs**

Preview deployments: register `*.zklogin-poc.pages.dev` (or each specific branch origin).

## Known issues / TODOs

See [`TODOS.md`](TODOS.md):
1. **Bundle activation + send** — `_isExactActivation` blocks batching. Need contract change.
2. **Google button layout jump** — pre-GSI placeholder flash.
3. **User-controlled salt** — currently `salt = Fr.ZERO`, one wallet per Google account.

See [`proof-enhancement-plans.md`](proof-enhancement-plans.md) for proof performance optimization strategy.
