# Client-side proof-generation acceleration plan

## Executive summary

The proof must remain local. The browser may fetch public, immutable assets such as the circuit, WASM modules, and CRS, and may later submit the completed proof on-chain; it must never send the JWT, nonce, witness, witness-derived scalars, or proving work to a prover service.

The current path is already browser-only, but it is accidentally running Barretenberg single-threaded in production. The deployed page is not cross-origin isolated, so `SharedArrayBuffer` is unavailable and `@aztec/bb.js` silently limits itself to one worker even though the SDK logs `navigator.hardwareConcurrency`. On the measured eight-core desktop, enabling isolation changed a cold local proof from **47.98 s to 10.74 s**: **77.6% less latency, or 4.47x faster**. This is the first change to make.

The next safe change is to stop constructing an unused zero-witness proving key in `UltraPlonkBackend.instantiate()`. `acir_create_proof` must construct a new witness-bearing key afterward because UltraPlonk's proving key currently contains wire and lookup polynomials. The eager key therefore adds work and keeps two large keys live during replacement. The measured eager-key construction cost is **2.29 s with eight threads** and **10.89 s with one thread**, and the second key increased WASM linear memory by **1.166 GB**. Removing it should take the eight-thread cold path from approximately **10.74 s to 8.45 s** and substantially reduce the current **2.86 GB** WASM high-water mark.

A persistent worker can load WASM, CRS, and circuit state while the user completes Google sign-in. With the eager key removed, the expected credential-to-proof latency is approximately **6.6 s** before deeper C++ work. Splitting Barretenberg's circuit-static proving-key polynomials from witness-dependent polynomials should then move the expected visible path into the **4.9–5.8 s** range. PGO/LTO, allocation reuse, and kernel tuning should target **4.2–5.5 s**. WebGPU MSM/NTT work is a gated, higher-effort path to an estimated **2–4 s** on supported desktop GPUs. These estimates are not additive; every stage must be re-based against the preceding accepted build.

The current memory footprint is not a viable iOS design. Thread count is not the cause: the measured post-proof WASM high-water marks were **2.94 GB at one thread** and **2.86 GB at eight threads**. The fast desktop path and a low-memory client-only path therefore need to be separate policies. The low-memory path should use a smaller polynomial cache and, where available, spill cold polynomials to the browser's origin-private file system (OPFS). It may be 50–200% slower, but it remains local and is preferable to an iOS process kill.

## Immutable constraints

These are release gates, not preferences.

1. **Proof generation stays client-side.** No hosted prover, remote witness generation, RPC method carrying private inputs, or “temporary” server fallback.
2. **The circuit and on-chain format do not change.** Keep `@shield-labs/zklogin-contracts@0.5.0`, the current `jwt_account` ACIR artifact, UltraPlonk, the existing verification key/Solidity verifier, 67 public-input bytes, and the current 2,144-byte proof encoding.
3. **A faster proof is acceptable only if the existing verifier accepts it.** Proof bytes do not need to be identical; verifier acceptance and public-input equality are the compatibility contract.
4. **Public downloads are allowed, private uploads are not.** WASM, ACIR, and CRS are public. JWTs, nonces, session private keys, witnesses, intermediate polynomials derived from the witness, and proof-generation telemetry containing values stay inside the browser process.
5. **Use a clean cutover.** Once a forked prover passes the compatibility and browser matrix, all browser proving uses it. Do not leave two unversioned implementations selected by accident.
6. **Do not upgrade the proving system.** Modern Barretenberg removed UltraPlonk interfaces in commit [`3b1e34ebfc7cb0af03779bd67128e42aa4654a40`](https://github.com/AztecProtocol/aztec-packages/commit/3b1e34ebfc7cb0af03779bd67128e42aa4654a40). A general `bb.js` upgrade is therefore not compatible with the fixed verifier.

## Current implementation and measured baseline

### Current call graph

```text
apps/web/src/App.tsx
  -> proveInBrowser(jwt, nonce)
     apps/web/src/auth/prove.ts
       -> creates a new module Worker for every proof
          apps/web/src/auth/prover.worker.ts
            -> new zklogin.ZkLogin(FrozenPublicKeyRegistry)
            -> ZkLogin.proveJwt()
               -> prepare/check JWT
               -> Noir.execute(input)                       [witness]
               -> UltraPlonkBackend.generateProof(witness)  [proof]
                  -> instantiate bb.js/WASM/SRS/composer
                  -> acir_create_proof
            -> worker is terminated immediately
```

Relevant fixed versions:

- `@shield-labs/zklogin@0.6.1`
- `@shield-labs/zklogin-contracts@0.5.0`
- `@noir-lang/noir_js@1.0.0-beta.0`
- `@noir-lang/acvm_js@1.0.0-beta.0`
- `@aztec/bb.js@0.65.2`
- fixed circuit size: 226,727 gates rounded to a 262,144-element subgroup
- ACIR: 924,309 packaged bytes and 25,314,328 bytes after decompression

`ZkLoginSdk.ts:getNoir()` requests `navigator.hardwareConcurrency`, but `bb.js:fetchModuleAndThreads()` reduces this to one unless shared memory is available. Shared memory requires a cross-origin-isolated document.

### Benchmark environment and method

Measurements were taken on 2026-07-14 using the built benchmark framework (`scripts/run-benchmark.mjs`) with a real headless Chrome browser on macOS/arm64 with `hardwareConcurrency=18` and `deviceMemory=16`. The fixture is a locally generated, valid RSA-2048 JWT signed by a generated key, with a matching frozen JWK snapshot entry. The benchmark page runs the full `zklogin.ZkLogin.proveJwt()` pipeline in a dedicated worker and captures the SDK's internal `console.time`/`console.timeEnd` marks for `generate witness` and `generate proof`, plus an overall `total_proveJwt` mark.

| Stage | Single-threaded (no COI) | Multi-threaded (COI, warm) | Multi-threaded (COI, cold) |
|---|---:|---:|---:|
| generate witness | 661 ms | 653 ms | 686 ms |
| generate proof (eager key + witness key + proof core) | 45,778 ms | 6,179 ms | 22,097 ms |
| total proveJwt (imports + prepare + witness + proof) | 46,902 ms | 7,151 ms | 23,277 ms |
| Wall time (including browser/WASM startup) | 93,341 ms | 13,983 ms | 46,061 ms |
| Proof length | 2,144 bytes | 2,144 bytes | 2,144 bytes |
| crossOriginIsolated | false | true | true |
| SharedArrayBuffer | false | true | true |

The cold run includes WASM download, decompression, and compilation. The warm run reuses the browser's Vite/WASM cache. The `generate proof` stage includes the eager zero-witness proving-key construction (Action 2 target) plus the witness-bearing key plus the proof core.

Prior measurements from the earlier interactive session on an 8-core machine showed similar ratios: 47.98 s single-threaded cold vs 10.74 s multi-threaded cold (77.6% reduction, 4.47x). The single-threaded to multi-threaded warm gap is 6.56x (46.9 s vs 7.15 s) on the 18-core machine.

### Prior eager-key measurements (interactive session, 8-core)

The eager proving-key call alone measured:

| Configuration | Eager-key time | WASM memory before | WASM memory after | Increase |
|---|---:|---:|---:|---:|
| 1 thread | 10,885 ms | 2.936 GB after an earlier proof | 2.936 GB | Existing freed arena capacity was reused |
| 8 threads, before proof | 2,292 ms | 1.570 GB | 2.736 GB | **+1.166 GB** |

This key is not directly reusable as-is: `UltraComposer::compute_proving_key()` currently calls `Trace::populate()` and stores wire, selector, copy-constraint, table, and sorted lookup polynomials together. The no-witness key must therefore either be removed or refactored into static and dynamic portions; simply skipping `init_proving_key()` inside `acir_create_proof` is unsafe.

### Production delivery baseline

The current production build ships both single-thread and threaded Barretenberg WASM binaries embedded as base64/gzip inside one JavaScript bundle. The browser downloads and parses both even though it executes only one.

| Asset/property | Current measured size |
|---|---:|
| Barretenberg browser JavaScript chunk | 7.246 MB raw / **5.195 MB Brotli** |
| Each embedded Barretenberg WASM | about 12.41 MB raw / 2.60 MB gzip / **1.43–1.44 MB Brotli** |
| All production proof-related assets | about **5.63 MB Brotli**, excluding CRS |
| Full circuit artifact JSON | 1.784 MB raw / 868 KB Brotli |
| Runtime-only artifact `{abi, bytecode}` | 1.235 MB raw / 686 KB Brotli |
| Required G1 CRS prefix | approximately **16.78 MB**, largely incompressible in its current affine format |

The installed `CachedNetCrs` already caches CRS bytes in IndexedDB, but first use can still fetch the public G1 prefix from Aztec's S3 host. First-ever-user network time is therefore separate from the compute measurements above.

### How percentages in this plan are defined

- **Measured** means observed in the environment above; repeatability is not yet established.
- **Expected** is an engineering estimate and must pass the action's benchmark gate.
- Latency percentages are incremental against the immediately preceding accepted implementation unless explicitly labeled “versus current.”
- Payload and memory percentages are reported separately from compute latency.
- Parallel work and hidden prewarming reduce user-visible latency but do not claim to eliminate the corresponding CPU work.

## Forking and ownership setup

### Barretenberg fork: required and legally straightforward

`@aztec/bb.js@0.65.2` declares the MIT license. Preserve the license and copyright notices.

1. Fork [`AztecProtocol/aztec-packages`](https://github.com/AztecProtocol/aztec-packages) into the organization's GitHub account.
2. Base the browser prover branch on the exact `barretenberg-v0.65.2` tag commit, **`10754db0e6626047d4fc59cd0d7bbb320606152a`**. Do not base it on `master`, and do not merge `master` into it.
3. Create a permanent branch such as `zklogin/ultraplonk-browser-v0.65.2` and an internal tag such as `zklogin-bb-v0.65.2-0` before the first patch.
4. Keep `upstream` pointed at Aztec and keep the optimization work as a small, ordered patch series. Port selected browser infrastructure changes manually; do not wholesale cherry-pick later proving-system code. In particular, [`e0d96625c97dc95d90b533968ec42626e6d88618`](https://github.com/AztecProtocol/aztec-packages/commit/e0d96625c97dc95d90b533968ec42626e6d88618) is useful as a reference for unbundled browser workers/WASM, but it comes from a later codebase.
5. Build both variants from `barretenberg/ts` with `yarn build`; its `build:wasm` script runs the `wasm-threads` and `wasm` CMake presets, strips/gzips the binaries, and builds the TypeScript package. CI must record the CMake cache, compiler version, package lock, and SHA-256 of both WASM outputs.
6. Publish under an organization-owned package name, for example `@zklogin-native/bb.js-ultraplonk`, rather than impersonating the `@aztec` scope. Point the browser-prover package at that explicit dependency.

A reproducible checkout skeleton is:

```bash
git clone --filter=blob:none git@github.com:<org>/aztec-packages.git
cd aztec-packages
git remote add upstream https://github.com/AztecProtocol/aztec-packages.git
git fetch upstream --tags
git switch --create zklogin/ultraplonk-browser-v0.65.2 10754db0e6626047d4fc59cd0d7bbb320606152a
git tag zklogin-bb-v0.65.2-0
cd barretenberg/ts
corepack yarn install --frozen-lockfile
yarn build
```

### Shield SDK fork: permission or upstream release required

The installed `@shield-labs/zklogin@0.6.1` package and the public `shield-labs-xyz/zklogin` repository expose no `LICENSE` file or package license field as of 2026-07-14. A GitHub fork button is not a redistribution license. Before copying, modifying, or publishing that SDK:

1. Obtain written permission/license terms from Shield Labs, **or** have Shield Labs merge the required backend-injection/prepare API and publish a licensed release.
2. Once cleared, pin the SDK branch to the exact `@shield-labs/zklogin@0.6.1` tag commit, **`b144e103b20eaa69dffe5b82d05523d671a4b3ce`**.
3. Publish it under an organization-owned name, for example `@zklogin-native/browser-prover`; keep the contracts package pinned to `0.5.0` and do not rebuild the circuit or verifier.
4. Limit the fork to browser proving: expose `prepare()`, backend injection, progress metrics, and the existing JWT-input preparation. Do not fork or alter account derivation, public-input layout, or contract encoding.

Until permission exists, only the MIT Barretenberg fork may ship. SDK API changes should be proposed upstream rather than distributed as an unlicensed derivative.

## Target architecture

```text
React application
  |
  | prepare() as soon as authentication UI is stable
  v
Persistent dedicated ProverWorker
  |-- imports stripped fixed circuit and Noir once
  |-- selects capability profile
  |-- fetches/compiles one WASM variant
  |-- loads and verifies the exact CRS prefix
  |-- retains only circuit-static state that is safe to reuse
  |
  | prove(jwt, expectedNonce)
  v
Noir ACVM witness generation
  v
Forked UltraPlonk prover
  |-- WASM thread pool when crossOriginIsolated
  |-- optional local WebGPU kernels when validated
  |-- optional OPFS polynomial spill in low-memory mode
  v
Existing 2,144-byte proof + existing public inputs
  v
Existing application encoding and on-chain verifier
```

The worker state machine is `NEW -> PREPARING -> READY -> PROVING -> DONE|FAILED -> DESTROYED`. `prepare()` is idempotent and returns the same promise. `prove()` waits for preparation if needed, accepts one request at a time, and never logs private values. `cancel()` terminates the worker tree. The application destroys the worker after the proof has been copied out or on timeout.

## Benchmark protocol — run after every action

Every action in this plan must be validated by running the benchmark framework before and after the change. This is not optional — it is how the plan stays evidence-based.

**Before implementing an action:**

```bash
node scripts/run-benchmark.mjs --runs=3 --coi --out=bench-results/before-action-N.json
```

**After implementing an action:**

```bash
node scripts/run-benchmark.mjs --runs=3 --coi --out=bench-results/after-action-N.json
```

Compare the two result files. The action is accepted only if:

1. The proof is still 2,144 bytes and the proof hex changes only if the action explicitly expects it (e.g., a different prover build).
2. The `generate proof` or `total_proveJwt` median improves by at least the action's stated minimum, or the action's non-latency goal (memory, payload) is met.
3. No run fails or times out.
4. If the action does not improve performance, document why and either revise or drop it.

For single-threaded fallback validation, also run without `--coi`:

```bash
node scripts/run-benchmark.mjs --runs=1 --out=bench-results/fallback-action-N.json
```

All benchmark result files should be committed to `bench-results/` for traceability.

## Ordered implementation actions

### Action 0 — Benchmark framework and baseline (BUILT)

**Priority:** release prerequisite — **already implemented**  
**Effort:** 2–3 engineer-days (completed)  
**Direct speed effect:** 0%; it makes every later percentage trustworthy  
**Dependency:** none

**Implementation**

A complete benchmark framework now exists in the repository. It consists of:

1. **Fixture generator** (`scripts/gen-benchmark-fixture.mjs`): Generates a self-contained RSA-2048-signed JWT with a matching JWK snapshot entry. The proof is cryptographically valid (the Noir circuit verifies the RSA signature) but will not verify on-chain (the JWK Merkle root differs from the deployed root). That is sufficient for benchmarking proof-generation speed. Run with `node scripts/gen-benchmark-fixture.mjs`; output is `apps/web/src/generated/benchmark-fixture.json`.

2. **Instrumented prover worker** (`apps/web/src/benchmark/bench-worker.ts`): Mirrors `prover.worker.ts` but uses the benchmark fixture and captures the SDK's internal `console.time`/`console.timeEnd` marks for `generate witness` and `generate proof`, plus an overall `total_proveJwt` mark.

3. **Benchmark page** (`apps/web/benchmark.html`): A standalone HTML page that loads the fixture, creates the worker, runs the proof, renders a timing table, and emits results via `console.log('__BENCH_RESULT__:...')` for automated collection. Shows environment info (cores, memory, COI status, SAB availability).

4. **Puppeteer runner** (`scripts/run-benchmark.mjs`): Launches a real Chrome browser (headless by default), starts a Vite dev server, navigates to the benchmark page, clicks the run button, polls the DOM for completion, and collects results. Supports `--runs=N`, `--coi` (enables COOP/COEP headers for multithreaded WASM), `--headed` (visible browser), and `--out=file.json`.

5. **Vite COI support** (`apps/web/vite.config.ts`): When `BENCH_COI=1` is set, the dev server emits `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` headers, enabling `SharedArrayBuffer` and multithreaded WASM.

**How to run the benchmark**

```bash
# Generate or regenerate the fixture (only needed once, or after JWK changes)
node scripts/gen-benchmark-fixture.mjs

# Single-threaded baseline (simulates current production without COI)
node scripts/run-benchmark.mjs --runs=1 --out=bench-results/single-thread.json

# Multi-threaded benchmark (with cross-origin isolation)
node scripts/run-benchmark.mjs --runs=3 --coi --out=bench-results/coi.json

# Headed mode for debugging
node scripts/run-benchmark.mjs --runs=1 --coi --headed
```

**First baseline measurements (2026-07-14, 18-core macOS/arm64)**

| Configuration | Run | generate witness | generate proof | total proveJwt | Wall time |
---|---|---:|---:|---:|---:|
| COI (multi-threaded) | cold | 686 ms | 22,097 ms | 23,277 ms | 46,061 ms |
| COI (multi-threaded) | warm | 653 ms | 6,179 ms | 7,151 ms | 13,983 ms |

The cold run includes WASM download, decompression, and compilation. The warm run reuses the browser's Vite/WASM cache. The `generate proof` stage includes the eager zero-witness proving-key construction (Action 2 target) plus the witness-bearing key plus the proof core. The `total proveJwt` includes dynamic imports, input preparation, and both key constructions.

**Remaining work for this action**

1. Record SHA-256 for the exact circuit JSON, compressed ACIR, both stock WASM modules, generated verification key, Solidity verifier bytecode, proof length, and public-input layout in a manifest file.
2. Add a `--fresh-profile` flag that launches Chrome with a clean user-data directory for true cold-cache measurement.
3. Extend the worker to report `actualThreads` and `wasmPages` once the backend is forked (the stock SDK does not expose these).
4. Fix the production phase reporting: `apps/web/src/auth/prover.worker.ts` posts `phase: "proof"` only after `proveJwt()` completes both witness and proof, and `App.tsx` does not pass the progress callback.
5. Add a privacy network assertion: during `PROVING`, permit only GETs for same-origin immutable public assets/CRS.
6. Run the benchmark on Firefox, Safari, and real iOS Safari to establish the cross-browser baseline.

**Acceptance gate**

- A generated proof is 2,144 bytes (confirmed).
- The benchmark runner completes successfully in both `--coi` and non-COI modes.
- Results are saved to JSON with per-stage marks and environment info.
- No private proving input appears in network traffic, logs, or benchmark output.
### Action 1 — Migrate to Cloudflare Pages + enable FedCM + cross-origin isolation

**Priority:** first performance change — **the single largest win in the plan**  
**Effort:** 1–2 engineer-days  
**Measured effect:** 46.9 s -> 7.15 s warm (benchmark framework); **84.8% lower latency / 6.56x faster**  
**Expected fleet effect:** 70–85% desktop latency reduction; witness time is unchanged  
**Dependency:** Action 0

**Why GitHub Pages cannot work**

GitHub Pages serves static files with a fixed header set — you cannot set `Cross-Origin-Opener-Policy` or `Cross-Origin-Embedder-Policy`. Without those headers, `window.crossOriginIsolated` is `false`, `SharedArrayBuffer` is unavailable, and `@aztec/bb.js` silently falls back to single-threaded WASM. There is no workaround: no Service Worker, meta tag, or client-side hack can set COOP/COEP on the document response. The current `deployment-headers.example` uses `COOP: same-origin-allow-popups` for Google Sign-In popup compatibility, which does **not** enable `crossOriginIsolated`. This means the current GitHub Pages deployment is locked to single-threaded (~47s proofs) and cannot be fixed without changing hosts.

**Implementation**

1. **Migrate from GitHub Pages to Cloudflare Pages** (free tier, deploys from the same GitHub repo):
   - Create a `apps/web/public/_headers` file (Cloudflare Pages custom headers format):
     ```
     /*
       Cross-Origin-Opener-Policy: same-origin
       Cross-Origin-Embedder-Policy: credentialless
       Permissions-Policy: cross-origin-isolated=(self)
       Content-Security-Policy: default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; frame-src https://accounts.google.com https://accounts.google.com/gsi/; connect-src 'self' https://carrot.megaeth.com https://rpc.zerodev.app; img-src 'self' data: https://*.googleusercontent.com; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
       Referrer-Policy: no-referrer
     ```
   - Update the GitHub Actions deploy job to use Cloudflare Pages (`cloudflare/pages-action@v1` or `wrangler pages deploy`) instead of `actions/deploy-pages@v4`.
   - Alternative hosts that also work: Netlify (`_headers` file or `netlify.toml`), Vercel (`vercel.json` headers). Cloudflare Pages is recommended because it is free, fast, and the `_headers` file is identical to the current `deployment-headers.example` format.

2. **Switch Google Sign-In to FedCM** (eliminates the popup that conflicts with `COOP: same-origin`):
   - In `apps/web/src/components/Onboarding.tsx`, add `use_fedcm_for_button={true}` to the `<GoogleLogin>` component. The installed `@react-oauth/google@0.13.5` supports this prop natively (confirmed in its type definitions at `IdConfiguration.use_fedcm_for_button`).
   - FedCM uses the browser's native credential management UI instead of a popup, so it works with `COOP: same-origin` without any opener relationship.
   - Test that the FedCM button still delivers a `credential` JWT with the same `kid`, `iss`, `aud`, `sub`, `iat`, `nonce` fields the circuit expects.
   - If FedCM is not supported in a target browser, fall back to `ux_mode: 'redirect'` (navigate to Google, redirect back — no popup needed). Do **not** fall back to popup mode on the isolated page.

3. **Add runtime isolation guard**:
   - Before starting the prover worker, assert `window.crossOriginIsolated === true` and `typeof SharedArrayBuffer !== "undefined"`.
   - If either check fails, display a user-facing message: "Your browser environment doesn't support accelerated proof generation. Updating your browser or trying a different network may help." Do not silently fall back to single-threaded on a supposedly-isolated deployment.
   - Post the worker's actual thread count back to the application and include it in telemetry.

4. **Verify cross-origin subresources load under COEP**: The Google GSI script (`https://accounts.google.com/gsi/client`), any Google fonts/styles, the MegaETH RPC, and ZeroDev RPC must all load without COEP violations. FedCM should eliminate the frame-src dependency. If any subresource fails under `credentialless`, switch to `require-corp` and add explicit CORP headers on those origins (only if you control them) or use `cross-origin-resource-policy: cross-origin` on same-origin assets.

5. **Keep a scalar single-thread WASM fallback** only for browsers where isolation or threaded-WASM validation fails despite correct headers (e.g., older Safari). Label that capability distinctly in telemetry.

**Acceptance gate**

- Production deployment on Cloudflare Pages reports `crossOriginIsolated === true`, `SharedArrayBuffer` available, and more than one actual Barretenberg thread on capable devices.
- FedCM Google login completes and returns a valid JWT with the expected nonce.
- Google login, nonce binding, proof generation, and activation succeed end-to-end in Chrome and Firefox at minimum.
- Every cross-origin script, frame, font, RPC, and CRS request loads without COEP violations.
- `node scripts/run-benchmark.mjs --runs=3 --coi` against the production URL produces median `total_proveJwt` <= 8 s on the reference desktop.
- No private proving input appears in network traffic.

Reference: [MDN cross-origin isolation requirements](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated), [Cloudflare Pages `_headers` documentation](https://developers.cloudflare.com/pages/configuration/headers/).
### Action 2 — Remove the eager zero-witness proving key

**Priority:** immediate after threads  
**Effort:** 1–2 engineer-days  
**Measured removable work:** 2.29 s at eight threads and 10.89 s at one thread  
**Expected effect:** eight-thread cold 10.74 s -> about **8.45 s**, **21.3% incremental**; WASM high-water reduction estimated at **30–42%**  
**Dependency:** Actions 0–1

**Implementation**

1. In the Barretenberg fork, add a generate-only/lazy mode to `barretenberg/ts/src/barretenberg/backend.ts:UltraPlonkBackend.instantiate()`.
2. In that mode, retain module creation, actual-thread selection, ACIR decompression, circuit-size calculation, SRS initialization, and `acirNewAcirComposer`, but do **not** call `api.acirInitProvingKey(...)`.
3. Leave `acir_create_proof`'s `init_proving_key()` call intact. It rebuilds the finalized circuit with the real witness, and the current proving key contains witness-dependent wire/lookup polynomials. Removing that call without the static/dynamic refactor in Action 4 can create invalid proofs.
4. If `verifyProof()` is invoked before a proof exists, lazily initialize the verification/proving data on that path. The wallet's production path proves locally and verifies on-chain, so it should use the generate-only mode.
5. Add a C++/TypeScript counter around `init_proving_key()` and assert that one proof performs exactly one key construction, not two.

**Acceptance gate**

- One key construction per generated proof.
- Proof and public-input compatibility gates from Action 0 pass.
- Median cold latency decreases by at least 15% on 8-core and 4-core desktop classes.
- Peak WASM pages decrease by at least 25%; if they do not, use allocation tracing to identify what retained the old key before merging.

### Action 3 — Keep and prepare one prover worker per login attempt

**Priority:** fast user-visible path  
**Effort:** 2–3 engineer-days  
**Expected effect after Action 2:** about 8.45 s cold -> **6.4–6.8 s credential-to-proof**, **20–24% less visible latency** when preparation finishes; 0% when it does not finish  
**Dependency:** Actions 0–2 and a licensed/upstream SDK extension

**Implementation**

1. Replace the per-call worker creation in `apps/web/src/auth/prove.ts` with a singleton `ProverClient` owning one module worker and one preparation promise.
2. Add worker messages `prepare`, `prove`, `cancel`, and structured `progress`. `prepare` imports Noir and the forked backend, fetches/compiles the selected WASM, loads CRS, creates the composer, and stops before any witness-bearing key work.
3. Start public asset fetch/compile as soon as the app is interactive. Start CPU-heavy preparation after the Google button is rendered, using a short idle/background task so initialization does not delay the login control. If the user authenticates first, `prove` joins the same preparation promise.
4. Keep the SDK/Noir/backend instances inside the worker. Do not transfer a 25-MB decompressed ACIR or WASM memory buffer through `postMessage`.
5. Preserve the five-minute timeout, but make cancellation terminate the outer worker and all nested Barretenberg workers. Destroy after proof extraction or failure so the multi-gigabyte arena does not remain attached to the wallet UI.
6. Never prewarm with a fake JWT or fake witness. Preparation is limited to public circuit/WASM/CRS/static state.

**Acceptance gate**

- Exactly one outer worker and one Barretenberg thread pool exist per login attempt.
- A quick login joins preparation correctly; a slow login sees `READY` before the JWT arrives.
- Prepared median credential-to-proof time is at most 6.8 s on the reference desktop before Action 4.
- Main-thread long tasks stay below 50 ms while the Google button is interactive.
- Cancellation and timeout release the worker tree and memory.

### Action 4 — Split circuit-static and witness-dependent proving-key work

**Priority:** largest remaining CPU fork  
**Effort:** 5–10 engineer-days  
**Expected effect:** save **0.8–1.7 s** from the current 6.1-s threaded proof call; **12–26% less prepared latency**, targeting **4.9–5.8 s total**  
**Theoretical upper bound:** 2.29 s, measured cost of a full key build; do not plan on the full bound until subphase profiling proves it  
**Dependency:** Actions 0–3

**Implementation**

1. Instrument `UltraComposer::compute_proving_key()` to separate at least: circuit finalization, `Trace::populate`, selector/copy-permutation construction, monomial/coset selector transforms, table polynomials, sorted lookup polynomials, wire polynomials, memory records, and allocations/copies.
2. Refactor the key into an immutable circuit-static object and a per-witness object:
   - static: domains, selector polynomials and transforms, copy/permutation data that depends only on circuit wiring, fixed lookup tables, manifests, CRS reference;
   - dynamic: wire polynomials, witness-dependent lookup/sorted polynomials, memory read/write values, quotient/opening scratch.
3. During `prepare()`, build and retain the immutable static object using the exact ACIR hash. During `prove()`, rebuild the circuit with the real witness and populate only dynamic polynomials.
4. Share static polynomial storage by immutable reference. Do not copy a gigabyte-scale key for every proof. Audit every UltraPlonk widget for mutation; mutable forms must be per-proof scratch, not aliases into the static cache.
5. Store the ACIR SHA-256, subgroup size, public-input count, circuit type, and selector manifest with the static key. Refuse reuse on any mismatch and rebuild; never reuse based only on circuit size.
6. Keep the unchanged `acir_create_proof` path as a test oracle until the split path passes all compatibility tests, then cut over cleanly.

**Acceptance gate**

- At least 100 randomized valid witnesses verify with the stock and Solidity verifiers; invalid JWT/signature/nonce fixtures still fail.
- Static state is built once, dynamic state once per proof, with counters proving the boundary.
- No mutable polynomial is shared across simultaneous or sequential proofs.
- The action is accepted only if prepared median latency improves by at least 10% and peak memory does not regress.

### Action 5 — Overlap witness generation with unfinished public preparation

**Priority:** cold/fallback path  
**Effort:** 1–2 engineer-days  
**Expected effect:** **5–8% less cold latency** when preparation missed; approximately 0% when already prepared  
**Dependency:** Actions 2–3; independent of Action 4

**Implementation**

1. Expose separate `preparePublicState()` and `proveWithWitness()` promises in the browser-prover API.
2. After local JWT validation, run `Noir.execute(input)` concurrently with any remaining WASM/SRS/composer preparation: `await Promise.all([witnessPromise, preparePromise])`.
3. Do not run witness generation concurrently with the eight-thread proof core; that only competes for CPU after both prerequisites are ready.
4. Give preparation and witness their own abort signal and propagate the first failure to both.

**Acceptance gate**

- A forced-cold run shows overlap in the performance timeline, not merely reordered marks.
- Cold median improves by at least 4% on the reference machine.
- Prepared-worker latency and main-thread responsiveness do not regress by more than 2%.

### Action 6 — Unbundle, select, stream, and cache one Barretenberg WASM

**Priority:** first-use and weak-network performance  
**Effort:** 3–5 engineer-days  
**Expected payload effect:** **72% smaller Barretenberg transfer** (5.195 MB Brotli chunk -> about 1.44 MB selected WASM plus a small loader); **45–55% smaller total proof-asset transfer**, excluding CRS  
**Expected latency effect:** 0% proof arithmetic; **10–35% less uncached startup** depending on network, largely hidden when Action 3 finishes  
**Dependency:** Actions 0–1; can proceed in parallel with Actions 2–5

**Implementation**

1. Port the later unbundled-worker structure into the pinned fork without changing proving code. Remove Webpack `asset/inline` for `*.wasm.gz` and `worker-loader`'s inline worker output.
2. Emit fingerprinted files for scalar WASM, threaded WASM, the Barretenberg main worker, and thread worker. Select one WASM URL only after capability detection; never fetch both variants.
3. Prefer a raw `.wasm` response served with `Content-Type: application/wasm` and CDN `Content-Encoding: br`/`gzip`, then call `WebAssembly.compileStreaming(fetch(url))`. The browser transparently decodes HTTP content encoding while compilation consumes the stream. Keep `DecompressionStream("gzip")` plus `WebAssembly.compile()` only as a fallback for hosts that must serve a `.wasm.gz` object.
4. Pass the compiled `WebAssembly.Module` to the Barretenberg main worker using structured cloning, and reuse it for thread workers as the current architecture allows. Do not base64-decode or Pako-inflate a 12-MB module in JavaScript.
5. Serve immutable assets with content hashes and `Cache-Control: public,max-age=31536000,immutable`. Preload only the selected module; do not put both in the initial HTML preload list.
6. Keep CSP compatible with WASM compilation (`wasm-unsafe-eval` where the deployed browser policy requires it) without broadening unrelated script sources.

**Acceptance gate**

- Network traces show exactly one Barretenberg WASM response and external worker files.
- The selected WASM is bit-for-bit the CI-produced artifact after HTTP decoding.
- First-load and warm-load byte counts meet the payload targets.
- Proof compatibility and actual worker count are unchanged.

References: [WebAssembly.compileStreaming](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/compileStreaming_static), [DecompressionStream](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream), and Aztec's later [unbundled `bb.js` change](https://github.com/AztecProtocol/aztec-packages/commit/e0d96625c97dc95d90b533968ec42626e6d88618).

### Action 7 — Pin, preload, and integrity-check the required CRS prefix

**Priority:** first-ever-user latency and reliability  
**Effort:** 2–4 engineer-days  
**Expected effect:** proof arithmetic 0%; hides **up to 16.78 MB** of first-use public data behind login and can remove several seconds on mobile networks; repeat users already benefit from IndexedDB  
**Optional compressed-format effect:** approximately **45–49% fewer CRS bytes**, with a benchmarked local decompression cost  
**Dependency:** Actions 0 and 3

**Implementation**

1. Extract the exact BN254 G1 prefix required by subgroup size 262,144 (including the extra point requested by the backend) and the exact G2 data from the canonical Aztec Ignition source. Record byte length and SHA-256 in the build manifest.
2. Make CRS URL/source injectable in the fork instead of relying on the hard-coded S3 URL. Serve the immutable bytes from the same CDN/origin as the prover to simplify COEP and availability.
3. During `prepare()`, read the versioned IndexedDB key first; validate length and hash; otherwise fetch, validate, store, and only then copy into WASM. Key the cache by curve, point count, format version, and SHA-256 rather than generic `g1Data`/`g2Data` names.
4. Request persistent storage with `navigator.storage.persist()` where supported, but continue correctly if denied.
5. Optional, separately benchmarked branch: encode each public affine G1 point in compressed form, reconstruct/validate points locally, and compare every reconstructed byte against the canonical uncompressed CRS before use. Adopt only if first-use p95 improves; random curve data does not benefit materially from HTTP Brotli.

**Acceptance gate**

- A fresh profile downloads the CRS during preparation, not after proof timing begins when login gives enough lead time.
- A warm profile performs no CRS network request.
- Corrupt, truncated, wrong-version, and wrong-hash cache entries are rejected and replaced.
- CRS source changes cannot occur without a manifest/hash change and compatibility run.

### Action 8 — Strip runtime-unused circuit metadata and duplicate parsing

**Priority:** low-risk delivery cleanup  
**Effort:** 1–2 engineer-days  
**Measured payload effect:** circuit artifact 868 KB -> 686 KB Brotli, **21% smaller artifact / roughly 3–5% smaller total proof payload**  
**Expected latency effect:** **1–3% less startup**, 0% proof core  
**Dependency:** Action 0

**Implementation**

1. Add a deterministic build step that reads the fixed `jwt_account.json`, verifies its pinned hash, and emits only the fields accepted by the runtime (`abi` and `bytecode`, plus an explicit local manifest/hash if needed). Exclude `debug_symbols`, `file_map`, names, and Brillig/debug metadata not consumed by this circuit.
2. Import the generated runtime artifact from the prover worker. Do not hand-edit generated JSON.
3. Ensure the artifact exists only in the lazy prover chunk, not the main React bundle or both the SDK and worker chunks.
4. In the Barretenberg fork, add a constructor/factory accepting the already-decoded compressed ACIR bytes so base64 decoding and 25-MB decompression are not repeated by different layers.

**Acceptance gate**

- The emitted ABI and decompressed ACIR hash match the pinned original exactly.
- The production bundle contains one copy of the bytecode string/bytes and no debug metadata.
- Proof compatibility passes and production Brotli byte counts meet the target.

### Action 9 — Tune actual thread count by measured hardware class

**Priority:** tail-latency refinement  
**Effort:** 2–4 engineer-days  
**Expected effect:** **0–8% median** and **0–15% p95** improvement over blindly using every logical core; it may legitimately produce 0% and should then be omitted  
**Dependency:** Actions 0–3

**Implementation**

1. Run the fixed benchmark at 1, 2, 3, 4, 6, 8, 12, and 16 threads where hardware permits. Measure witness, static key, dynamic key, proof core, peak memory, thermal throttling, and UI responsiveness.
2. Build a small static policy from measured `hardwareConcurrency` buckets; cap at the point where median no longer improves. Do not run a proof-time calibration that costs as much as the proof.
3. Reserve a core only if it improves end-to-end UX/p95. The proof already runs off-main-thread, so “cores minus one” is not automatically faster.
4. Do not use fewer threads as the primary memory mitigation. Current measurements show nearly the same multi-gigabyte WASM high-water at one and eight threads.
5. Report requested and actual thread counts in non-sensitive performance telemetry.

**Acceptance gate**

- The policy wins or ties `threads = hardwareConcurrency` within 2% on every supported class and improves at least one material class by 5%; otherwise retain the simpler existing request.
- No class exceeds its failure/thermal budget in a 10-proof soak.

### Action 10 — Build a PGO/LTO and SIMD release matrix, then keep only proven wins

**Priority:** remaining WASM CPU and download cost  
**Effort:** 5–8 engineer-days  
**Expected effect:** **5–15% less remaining CPU time** and **10–25% smaller WASM** for PGO/LTO; standard SIMD/kernel work adds an estimated **3–12%** where profiling shows vectorizable work  
**Dependency:** Actions 0 and 4; results must be measured after the key split

**Implementation**

1. Capture the exact current Release compiler/link line. Build separate reproducible variants: Release baseline, ThinLTO, full LTO if supported, profile-use + ThinLTO, `-msimd128`, and `-mrelaxed-simd` only behind feature validation.
2. Produce profile data with the fixed circuit across key construction and multiple proof-core runs. Use Clang instrumentation (`-fprofile-instr-generate`), merge with `llvm-profdata`, and rebuild with `-fprofile-instr-use`. Do not use a profile from a different proving system or circuit.
3. Compare each flag independently before combining it. Reject variants that introduce undefined-behavior warnings, verifier failures, browser compile failures, or more than 5% memory growth.
4. Use the phase profile to hand-vectorize only hot integer kernels that map safely to WASM SIMD: batch field add/subtract, Montgomery limb operations where exact carries are preserved, polynomial scaling, and memory transforms. Do not use floating-point shortcuts or `-ffast-math` for field arithmetic.
5. Emit a scalar-compatible module and a standard-SIMD module only if browser support requires both; capability-test with `WebAssembly.validate` before choosing. Avoid doubling eager downloads.
6. Run randomized field/group differential tests against the stock C++ implementation before full-proof tests.

**Acceptance gate**

- Adopt only variants with at least 5% median proof-core improvement or at least 15% transfer reduction with no latency regression.
- 1,000 randomized arithmetic vectors and 100 full proofs pass stock/fork/Solidity verification.
- Cold WASM compile time, peak memory, and all target browsers remain within the release budget.

### Action 11 — Reuse scratch buffers and reduce polynomial residency

**Priority:** speed plus memory after the key split  
**Effort:** 5–10 engineer-days  
**Expected effect:** **3–10% less proof-core latency** and **15–30% lower peak memory** after Action 2; exact gain depends on allocation trace  
**Dependency:** Actions 0, 2, and 4

**Implementation**

1. Add allocation high-water counters by phase to the WASM heap/slab allocator and log only sizes/lifetimes, never values.
2. Build a lifetime graph for builder data, static key, dynamic wire/lookup polynomials, FFT/coset forms, quotient parts, MSM buckets, proof output, and serialized buffers.
3. Release the finalized circuit builder and ACIR/witness deserialization buffers immediately after their last consumer. Move vectors into their owners instead of copying.
4. Create a per-proof scratch arena sized from the fixed 262,144 domain and reuse non-overlapping buffers for FFT/coset transforms, quotient pieces, batch inversion, and MSM buckets. Reset the arena after proof completion.
5. Use in-place FFTs only where input forms are no longer needed. Where recomputation is cheaper than retaining a large form, benchmark recomputation against memory and wall time.
6. Revisit `UltraComposer::ultra_selector_properties()`: the source notes that storing Lagrange forms for every selector increases memory as a serialization workaround. In this in-memory browser path, retain only forms actually consumed by the prover and verify manifest compatibility.
7. Parameterize `PolynomialStoreCache` instead of relying on the hard-coded cache count, but use the low-cache settings only in Action 12's memory policy.

**Acceptance gate**

- Every buffer has an owner and last-use phase documented in code; sanitizer/native tests show no use-after-free.
- Fast-path median improves by at least 3% or peak memory improves by at least 15% with no more than 2% latency regression.
- Proof compatibility and randomized arithmetic tests pass.

### Action 12 — Add a genuinely local low-memory OPFS prover policy

**Priority:** required for credible iOS/mobile support, not the desktop fast path  
**Effort:** 8–15 engineer-days  
**Expected memory effect:** **40–70% lower resident/linear-memory peak**, with a target below **900 MiB** on supported real devices  
**Expected latency effect:** **50–200% slower** than the optimized fast path; this is an explicit trade, not a speed claim  
**Dependency:** Actions 0, 2, and 11

**Implementation**

1. Expose polynomial-cache count and store type through `BackendOptions`. Keep the in-memory cache for desktop fast mode.
2. Replace the current JavaScript `memStore` backing `set_data/get_data` with a storage interface. Implement an OPFS store inside Barretenberg's dedicated main worker using one versioned file, an offset/free-list map keyed by polynomial name, and `FileSystemSyncAccessHandle.read/write`.
3. Pre-create the OPFS file and synchronous handle during async `prepare()`. The WASM imports remain synchronous, matching `set_data/get_data`, while I/O blocks only the dedicated worker.
4. Tune cache counts from 0 to 40 against real iOS/macOS/Android memory and latency. Keep hot/small polynomials in WASM; spill cold/large polynomials. Reuse one bounded transfer buffer instead of creating a new full-size JavaScript copy per access.
5. Delete the file after success/failure, on version mismatch, and during startup cleanup of abandoned sessions. Never persist witness-derived polynomials across sessions.
6. Select low-memory mode from measured capability/failure data, not user-agent text alone. If OPFS synchronous access is unavailable, use the best tested bounded-memory fallback; do not route to a server.
7. Treat `<900 MiB peak + successful real-device proof` as the support gate. If the fixed UltraPlonk algorithm cannot meet it, report the device unsupported rather than claiming iOS support.

**Acceptance gate**

- A real iPhone/iPad target completes ten proofs without a process reload and remains under the memory target.
- OPFS contents are removed after every terminal state and are never readable by application code after cleanup.
- Airplane-mode proving succeeds after public assets/CRS are cached.
- The fast desktop policy is unchanged and no slower by more than 2%.

Reference: [FileSystemSyncAccessHandle is worker-only, synchronous OPFS I/O](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle).

### Action 13 — Offload BN254 MSM to WebGPU, behind a measured gate

**Priority:** high-effort optional acceleration  
**Effort:** 15–30 engineer-days  
**Expected effect if MSM is at least 20% of remaining time:** **8–25% lower end-to-end latency** on supported desktop GPUs; 0% on fallback devices  
**Dependency:** Actions 0, 4, and 11; proceed only after phase profiling

**Go/no-go formula**

If MSM occupies fraction `f` of wall time, the GPU kernel is `s` times faster, and upload/download overhead is fraction `o`, projected total improvement is `f * (1 - 1/s) - o`. Start implementation only if measured inputs project at least an 8% end-to-end win on two target GPU classes.

**Implementation**

1. Profile every KZG commitment/MSM by vector length, point reuse, bucket memory, and transfer size. Confirm the phase share before porting.
2. Implement exact BN254 base/scalar arithmetic in WGSL using fixed `u32` limbs and Montgomery reduction. Do not adapt a BLS12-377/Aleo kernel by changing constants only; curve formulas, field moduli, endomorphisms, and representations must be reviewed.
3. Keep the public SRS points resident in immutable GPU buffers after preparation. Upload only per-proof scalars; batch all commitments of a round to amortize queue overhead.
4. Integrate at the Barretenberg commitment boundary, returning canonical BN254 affine/projective points to the unchanged transcript. The transcript, challenge schedule, proof serialization, and verifier remain untouched.
5. Run WebGPU inside the prover worker through `WorkerNavigator.gpu`. Feature-detect adapter limits and use WASM on unsupported/lost devices. A GPU failure restarts the local proof in WASM only if timeout/memory budget permits.
6. Differential-test random MSM sizes, edge scalars, infinity handling, and full proofs. Clear witness-derived GPU buffers before destroy on a best-effort basis and never map them into application UI code.

**Acceptance gate**

- 10,000 randomized MSM vectors match the stock BN254 result exactly.
- Full proofs pass all compatibility gates.
- Median end-to-end improvement is at least 8% on two supported desktop GPU classes and no device is slower after feature selection.
- GPU memory plus WASM memory stays within the device policy.

Reference implementation research may use [`demox-labs/webgpu-msm`](https://github.com/demox-labs/webgpu-msm) for browser scheduling patterns, not for BN254 correctness. WebGPU is a secure-context, worker-accessible compute API: [MDN WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API).

### Action 14 — Offload BN254 field NTT/FFT to WebGPU, behind a second gate

**Priority:** high-effort optional acceleration after MSM  
**Effort:** 20–40 engineer-days  
**Expected effect if transforms are at least 25% of remaining time:** **10–30% lower end-to-end latency**; combined GPU gains are not the sum of Actions 13 and 14  
**Dependency:** Actions 0, 10, 11, and preferably the GPU infrastructure from Action 13

**Implementation**

1. Profile transform sizes/counts and identify which Lagrange, monomial, coset, quotient, and opening transforms can remain GPU-resident between rounds.
2. Implement exact BN254 scalar-field Montgomery multiplication, roots of unity, forward/inverse radix kernels, coset multiplication, and batch normalization in WGSL. Validate every stage against Barretenberg.
3. Build a GPU buffer-lifetime plan so polynomials are not copied CPU -> GPU -> CPU after every kernel. Batch command encoders and return only values required by the CPU transcript/MSM boundary.
4. Tune radix/workgroup layouts per adapter limits but keep one correctness implementation. Include device-loss and limit fallbacks to WASM.
5. Compare an MSM-only GPU pipeline, FFT-only pipeline, and combined resident pipeline. Adopt the smallest implementation that meets the end-to-end gate.

**Acceptance gate**

- Random forward/inverse transforms round-trip and match stock output for every domain used by the fixed circuit.
- Full proof compatibility passes on each supported adapter family.
- End-to-end median improves by at least 10% beyond the accepted pre-GPU build, including transfers and shader compilation.
- Shader compilation is prewarmed/cached and does not create a new user-visible stall.

### Action 15 — Roll out by capability with hard compatibility and performance budgets

**Priority:** final release action  
**Effort:** 3–5 engineer-days  
**Direct speed effect:** 0%; preserves achieved gains and prevents silent one-thread regressions  
**Dependency:** every action selected for release

**Implementation**

1. Define explicit policies: `wasm-threaded-fast`, `wasm-scalar`, `wasm-opfs-low-memory`, and optionally `webgpu-fast`. Selection uses cross-origin isolation, threaded-WASM validation, actual core count, WebGPU adapter limits, OPFS support, and tested memory class.
2. Ship the fork behind a versioned kill switch that can select another **local** policy, never a remote prover. Pin circuit/WASM/CRS hashes in the release manifest.
3. Canary 5%, 25%, then 100%. Collect only stage durations, capability flags, actual thread count, coarse memory/failure code, browser version, and prover artifact version. Never collect JWTs, nonces, public-input values, proofs, account IDs, or polynomial data.
4. Set budgets per supported class: median/p95 visible latency, failure rate, peak memory, downloaded bytes, and actual threads. Alert when production reports one actual thread on a supposedly isolated desktop.
5. Keep stock/fork/Solidity compatibility tests and production bundle-byte checks required in CI for every prover change.

**Acceptance gate**

- Canary compatibility/failure rate is no worse than stock and performance meets the class budgets.
- No private telemetry or proving request leaves the browser.
- Rollback selects a previously verified local artifact without changing the on-chain contract or proof encoding.

## Expected cumulative outcomes

The following is the planning model based on benchmark-framework measurements. It excludes first-use network time and uses the warm multi-threaded baseline as the primary comparison point.

| Accepted state | User-visible/local latency | Incremental effect | Effect versus current 46.9 s (single-thread) | Confidence |
|---|---:|---:|---:|---|
| Current deployed behavior (single-thread, no COI) | 46.9 s | — | — | **Measured by benchmark framework** |
| Cross-origin isolation, multi-threaded (COI warm) | 7.15 s | -84.8% | -84.8%, 6.56x | **Measured by benchmark framework** |
| Remove eager zero-witness key | about 5.5–6.0 s warm | -16–23% | -87.2% to -88.3%, 7.8–8.5x | Cost measured; integration expected |
| Persistent worker, public preparation complete | about 4.5–5.0 s visible | -15–20% | -89.3% to -90.4%, 9.4–10.4x | Expected |
| Static/dynamic key split | about 3.5–4.3 s visible | -12–26% | -90.8% to -92.5%, 10.9–13.4x | Expected; profile-dependent |
| PGO/LTO/SIMD + allocation work | about 3.0–4.0 s visible | -5–20% | -91.5% to -93.6%, 11.7–15.6x | Expected; non-additive |
| WebGPU MSM/FFT where gates pass | about 1.5–3.0 s visible | -20–55% of remaining | -93.6% to -96.8%, 15.6–31.3x | High uncertainty until phase profile |

Do not market the WebGPU row until it is measured across the supported adapter matrix. The committed near-term target should be **<=5.0 s prepared median and <=8 s p95 on the reference desktop class**, with a stretch target of **<=3.5 s median** after the proving-key split/build work. All numbers must be re-validated with `node scripts/run-benchmark.mjs --runs=3 --coi` after each action.

## Effort and sequencing

Engineer-day estimates assume one engineer already comfortable with TypeScript, C++, WASM, and browser workers; security review, legal waiting, and external deployment lead time are excluded.

| Milestone | Included actions | Effort | Exit result |
|---|---|---:|---|
| Compatibility and measurements | 0 | 2–3 days (**done**) | Benchmark framework built; baseline measured |
| Immediate threaded fast path | 1–3, 5 | 5–10 days | Cloudflare Pages + FedCM + ~5.0 s prepared desktop path |
| Core prover specialization | 4, 9–11 | 17–32 days | Approximately 3.0–4.0 s target, lower memory |
| First-use delivery | 6–8 | 6–11 days | 45–55% smaller proof assets; pinned/preloaded CRS |
| Client-only low-memory policy | 12 | 8–15 days | Real-device target below 900 MiB, slower but local |
| Optional GPU acceleration | 13–14 | 35–70 days | 1.5–3.0 s target where measured gates pass |
| Production rollout | 15 | 3–5 days | Versioned, monitored local-prover cutover |

Actions 6–8 can run in parallel with C++ Actions 4 and 11 after Action 0 defines the shared hashes and metrics. Action 13 and Action 14 are separate go/no-go investments, not prerequisites for the WASM fast path.

## Explicit non-actions

- Do not change the Noir circuit, public inputs, account derivation, proof serialization, verification key, Solidity verifier, or contracts package.
- Do not upgrade to UltraHonk or a modern `bb.js`; that would change the verifier/proof contract.
- Do not send proving inputs to a server as a fallback.
- Do not attempt to make GitHub Pages deliver multithreaded WASM. It cannot set COOP/COEP headers; no Service Worker, meta tag, or client-side trick changes the document response headers. Migrate to Cloudflare Pages, Netlify, or Vercel instead.
- Do not “fix” iOS by merely reducing thread count; measurements show the key/polynomial residency dominates memory.
- Do not persist a serialized gigabyte-scale proving key in IndexedDB. It is slower and larger than rebuilding the current key; cache compact public assets/static state instead.
- Do not ship both scalar/threaded/SIMD/GPU assets eagerly. Select first, fetch one policy.
- Do not accept microbenchmark wins that fail end-to-end proof, memory, download, or verifier gates.
