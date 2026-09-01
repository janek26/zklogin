# Passport Recovery Implementation Plan

## Delivery target

Implement a fresh Ethereum Sepolia (`11155111`) wallet deployment with self-passport recovery. The feature must be implementable from this document without product decisions beyond the declared deployment inputs.

**Completion gate:** unit tests, typecheck, and production build. Do not add manual, browser E2E, live-passport, or live-Sepolia test gates to this implementation task.

## Product contract

### Ordinary wallet

- Google zkLogin remains the ordinary sign-in and 24-hour session path.
- The wallet remains native-ETH-only in the UI.
- A user may make the wallet recoverable with **their own** ZKPassport identity.

### Recovery

- One self-passport guardian per wallet.
- Guardian proof can propose exactly one replacement local owner.
- At guardian setup or rotation, the user selects one delay: **Immediate**, **1 day**, **3 days**, **7 days**, or **30 days**. New setup defaults to **7 days**; rotation preselects the current delay.
- The proposed owner completes recovery after the stored delay. For **Immediate**, completion is possible as soon as the proposal confirms; there is no dependable cancellation window.
- Before a non-immediate deadline, a normal Google/session signer can cancel the proposal. They may keep the passport guardian or batch cancellation with guardian removal.
- The proposed owner is a random local `secp256k1` key, generated in the browser and stored only in browser `localStorage`. It is deliberately unsafe and must be labelled as such after recovery. The existing native Send UI is how the user moves assets away; do not add a separate migrate-funds surface.
- After finalization, the local key is the wallet's permanent root owner. Keep its local-storage entry until explicit irreversible forget; deleting it automatically at finalization would strand the user before they can send funds.
- If the browser/origin/storage that holds a pending local key disappears, the user starts a new passport recovery in any compatible recovery client. The new proposal replaces the old one and begins its selected delay again. Do not display or export the key.

### Availability and sponsorship

- This app uses the existing ZeroDev sponsorship path for all recovery UserOperations. Users and passport guardians are never expected to hold Sepolia ETH.
- Sponsorship is non-custodial but not censorship-resistant: the app's paymaster may delay or reject a recovery UserOperation, but cannot redirect funds or change the recovery owner.
- The V2 contract and its signatures must be paymaster-agnostic. A self-hosted recovery client or another application may use another sponsor, a funded EntryPoint deposit, or user-paid gas.
- Recovery is assumed domain-independent for this POC. Ship a minimal static recovery artifact separately from the normal dashboard so it can be hosted or run independently. Domain-origin hardening is deferred.

## ZKPassport policy and privacy

Use the supplied ZKPassport Dashboard policy integration exactly:

```tsx
<ZKPassportQRCode
  domain="zklogin-poc.rahrt.com"
  mode="compressed-evm"
  query={(builder) =>
    builder
      .policy("policy-1")
      .bind("user_address", walletAddress)
      .bind("chain", "ethereum_sepolia")
      .bind("custom_data", binding)
      .done()
  }
  onResult={({ verified, proofs, sdkInstance }) => {
    if (!verified) return
    const params = sdkInstance.getSolidityVerifierParameters({
      proof: proofs[0],
      scope: "policy-1:1",
    })
    // hand params to the appropriate sponsored V2 UserOperation
  }}
/>
```

`policy-1` and `policy-1:1` are fixed and immutable for this POC. The policy must require strict face match and request no passport-attribute disclosure. It is a deployment prerequisite, not a user-selectable UI value.

The plan adds `custom_data` to the supplied base sample. It is mandatory: wallet and chain binding alone do not bind a recovery proof to its action, selected local owner, or nonce.

The V2 contract stores the returned ZKPassport `uniqueIdentifier` as the guardian identifier. Since `policy-1:1` is a fixed global scope, the same passport produces the same pseudonymous identifier for every wallet under this domain/scope. This permits public cross-wallet correlation. It does not disclose the passport holder's name, document number, photo, nationality, birth date, or document image.

The setup disclosure must say exactly:

> Your passport app creates a zero-knowledge proof. This wallet does not receive or store your name, passport number, document image, face image, nationality, or date of birth. On chain, it stores a pseudonymous passport identifier. Because this identifier uses the same recovery policy for every wallet, observers can link wallets that use the same passport recovery identity.

On-chain verification is based on ZKPassport's consumer pattern:

- `mode == compressed-evm` proof;
- pinned ZKPassport root verifier;
- `verified == true`;
- `params.serviceConfig.devMode == false`;
- `helper.verifyScopes(publicInputs, "zklogin-poc.rahrt.com", "policy-1:1")`;
- `boundData.senderAddress == kernel wallet address`;
- `boundData.chainId == block.chainid`;
- `params.serviceConfig.validityPeriodInSeconds == 604800` (seven days);
- `helper.isFaceMatchVerified(FaceMatchMode.STRICT, OS.ANY, committedInputs)`; and
- exact action binding in `boundData.customData`.

Use ZKPassport's seven-day `validityPeriodInSeconds` as shown in the supplied verifier pattern. Do not add a separate application timestamp or custom proof-age rule.

## Network cutover: MegaETH to Ethereum Sepolia

This is a clean testnet cutover. MegaETH wallet addresses, balances, deployments, and ZeroDev project configuration do not migrate to Sepolia. Legacy users may transfer test assets while their existing session works; V1 is not upgraded or bridged.

Apply the cutover as one change set:

1. In `apps/web/src/config.ts`, replace `megaethTestnet` with `sepolia`, `6343` with `11155111`, and import `deployment-sepolia.json`.
2. Replace `VITE_MEGAETH_TESTNET_RPC_URL` with `VITE_SEPOLIA_RPC_URL` in config, `.env.example`, setup documentation, and all checks.
3. Use a Sepolia-specific ZeroDev project/RPC URL and gas policy. The policy must sponsor Google activation, normal native-send operations, guardian setup, recovery proposal, cancellation, guardian removal, and recovery finalization at the V2 proof-verification gas envelope.
4. Replace `apps/web/src/generated/deployment-megaeth.json` with `deployment-sepolia.json`; update `scripts/check-prereqs.mjs` and `scripts/verify-deployment.mjs` together.
5. Generate new Sepolia deployment metadata for EntryPoint 0.7, Kernel 0.3.3, Kernel factory/meta-factory, Google UltraVerifier, V2 validator, ZKPassport root verifier, certificate registry, circuit registry, and all expected runtime code hashes.
6. Update `README.md`, `SETUP.md`, contract deployment instructions, fixture names, environment-variable names, chain explorer links, and the ZeroDev policy directions in the same commit.
7. Remove MegaETH-specific generated deployment references after every caller uses Sepolia. Do not leave compatibility aliases.

The exact ZKPassport external addresses and code hashes are deployment inputs. Pin installed package and Foundry dependency revisions in `pnpm-lock.yaml` and `contracts/lib`; record the runtime hashes in Sepolia deployment metadata. Check code existence/hash before deployment and in `verify:deployment`.

## Contract design

### New files and dependencies

Add:

```sh
pnpm add @zkpassport/ui @zkpassport/sdk
cd contracts && forge install zkpassport/circuits@<audited-commit>
```

Add the documented remapping to `contracts/foundry.toml`:

```toml
remappings = ["@zkpassport/=lib/circuits/src/solidity/src/"]
```

Create `contracts/src/ZkLoginKernelValidatorV2.sol`. Do not mutate V1 for the Sepolia deployment. Create a V2 deployment script rather than reusing the MegaETH script generation.

### Constructor configuration

V2 constructor parameters are immutable:

```solidity
IProofVerifier googleProofVerifier;
bytes32 googleJwkRoot;
bytes32 appId;
ZKPassportRootVerifier zkPassportVerifier;
```

Use Solidity constants for:

```solidity
string constant PASSPORT_DOMAIN = "zklogin-poc.rahrt.com";
string constant PASSPORT_SCOPE = "policy-1:1";
uint256 constant PASSPORT_VALIDITY = 7 days;
bytes32 constant RECOVERY_DOMAIN = keccak256("ZKLOGIN_PASSPORT_RECOVERY_V2");
```

The selectable delay values are constants:

```solidity
uint48 constant DELAY_IMMEDIATE = 0;
uint48 constant DELAY_1_DAY = 1 days;
uint48 constant DELAY_3_DAYS = 3 days;
uint48 constant DELAY_7_DAYS = 7 days;
uint48 constant DELAY_30_DAYS = 30 days;
```

`setGuardian` accepts only these exact delay values. No user-supplied arbitrary timestamp or delay is valid.

### State

Use explicit fields rather than overloaded V1 session state:

```solidity
struct RecoveryProposal {
    address proposedOwner;
    uint48 executableAt;
    uint64 nonce;
}

struct AccountState {
    bytes32 accountId;
    address sessionKey;
    uint48 sessionValidUntil;
    bytes32 guardianNullifier;
    uint48 recoveryDelay;
    uint64 guardianNonce;
    uint64 recoveryNonce;
    address permanentOwner;
    RecoveryProposal recovery;
}
```

Invariants:

- `guardianNullifier == bytes32(0)` means recovery is disabled.
- A wallet has at most one guardian and one proposal.
- A guardian replacement overwrites its identifier and delay immediately, increments `guardianNonce`, and requires no recovery proposal.
- A recovery proposal records the current `recoveryDelay`; `executableAt = uint48(block.timestamp) + recoveryDelay`.
- A new proposal increments `recoveryNonce`, replaces the old proposal, and derives a fresh deadline from the currently configured delay.
- `permanentOwner == address(0)` means ordinary Google/session access remains valid. A finalized recovery sets it permanently; after that, modes `0x00` and `0x01` must reject.
- Only a non-zero EOA is accepted as `proposedOwner` in V1. Reject deployed-code addresses using `proposedOwner.code.length == 0` at proposal execution.

### Canonical bindings

Pass an exact ASCII `custom_data` representation of the hash below. TypeScript and Solidity must share one helper and tests must use it; do not hand-assemble one-off strings.

```solidity
keccak256(
  abi.encode(
    RECOVERY_DOMAIN,
    block.chainid,
    kernel,
    action,
    proposedOwner,
    guardianNonce,
    recoveryNonce
  )
)
```

Actions:

- `SET_GUARDIAN`: `proposedOwner = address(0)`; binds the next `guardianNonce`.
- `PROPOSE_RECOVERY`: binds the selected local owner and next `recoveryNonce`.

For proposal validation, require the `user_address` binding to equal the Kernel address. This is the `msg.sender` value while V2 executes through `Kernel.execute`; it is not the browser key or an EOA relayer.

### Passport verification helper

Implement one internal `_verifyPassport(params, kernel, expectedBinding)` helper. It must perform every listed ZKPassport check and return only the `uniqueIdentifier`. It never accepts a caller-controlled domain, scope, validity, action, chain, or bound wallet.

Use this helper in two places for a recovery proposal:

1. V2 signature validation rejects an invalid proof before the paymaster accepts an operation.
2. Exact execution re-verifies the identical proof before state changes.

This is intentionally two proof verifications. It is the simplest trustless sponsored path: invalid proofs do not reach sponsored execution, and validation does not persist recovery authorization state that could survive a failed operation.

### Methods and authorization modes

| Mode | Signer/proof | Exact permitted effect |
|---|---|---|
| `0x00` | Existing Google zkLogin proof, only before finalization | Existing exact session activation only |
| `0x01` | Existing active session key, only before finalization | Existing normal Kernel operations |
| `0x02` | Valid self-passport proposal proof | Exact `proposeRecovery(params, proposedOwner, recoveryNonce)` only |
| `0x03` | Pending proposed local owner | Exact `finalizeRecovery(recoveryNonce)` only, at/after deadline |
| `0x04` | Finalized permanent local owner | Existing normal Kernel operations |

Required V2 functions:

```solidity
function setGuardian(
    ProofVerificationParams calldata params,
    uint48 delay
) external;

function clearGuardian() external;

function cancelRecovery() external;

function proposeRecovery(
    ProofVerificationParams calldata params,
    address proposedOwner,
    uint64 recoveryNonce
) external;

function finalizeRecovery(uint64 recoveryNonce) external;
```

All functions are called through the Kernel. `setGuardian`, `clearGuardian`, and `cancelRecovery` require `msg.sender` to be an installed Kernel and are authorized by existing Google/session mode. `setGuardian` and `clearGuardian` reject while a recovery proposal exists.

`cancelRecovery()` clears the proposal only. The frontend batches `cancelRecovery()` and `clearGuardian()` in one normal signed Kernel UserOperation when the user selects “Remove guardian too.”

`proposeRecovery()` requires `msg.sender` to be the Kernel, requires exact `recoveryNonce`, re-verifies the supplied passport params against the expected `PROPOSE_RECOVERY` binding, requires the resulting nullifier to equal `guardianNullifier`, and writes the proposal. It cannot transfer funds or call another target.

`finalizeRecovery()` requires the matching proposal and `block.timestamp >= executableAt`. The mode-`0x03` validator must reconstruct the exact Kernel execution calldata for this function and compare hashes. It then permits only the proposed local owner's ECDSA signature. `finalizeRecovery()` clears the proposal and assigns `permanentOwner`.

Mode `0x04` verifies `permanentOwner` ECDSA signatures. The frontend deliberately exposes only existing native send capability for this unsafe state, but the contract keeps standard root-authority semantics.

### Exact sponsored proposal UserOperation

`PassportProposalAuth` contains the full `ProofVerificationParams`, the `proposedOwner`, and the expected `recoveryNonce`. Mode `0x02` must:

1. ABI-decode `PassportProposalAuth` from `userOp.signature[1:]`.
2. Reconstruct the exact Kernel `execute` call that invokes `proposeRecovery` with the same `params`, owner, and nonce.
3. Reject non-identical `userOp.callData`.
4. Call `_verifyPassport` with the expected `PROPOSE_RECOVERY` binding.
5. Return successful validation without changing state.

The execution function receives the same calldata and re-verifies it before writing state. This makes the existing `createZeroDevPaymasterClient` sponsorship seam usable without a relayer or guardian-funded transaction.

## Frontend architecture

### Files to add

- `apps/web/src/aa/recoveryValidator.ts` — modes `0x02`, `0x03`, and `0x04` Kernel-validator adapters; shared UserOperation hashing/signature construction follows `aa/zkLoginValidator.ts`.
- `apps/web/src/lib/recovery.ts` — V2 ABI, public recovery-state reads, allowed-delay values, canonical bindings, exact call-data builders, and recovery local-storage helpers.
- `apps/web/src/components/RecoveryBanner.tsx` — disabled, pending, and unsafe-recovered banners.
- `apps/web/src/components/RecoverySetup.tsx` — add/rotate self-passport guardian and delay selection.
- `apps/web/src/components/PassportProofRequest.tsx` — sole `ZKPassportQRCode` wrapper; takes an app-derived action, wallet, proposed owner, and nonce, never raw policy configuration.
- `apps/web/src/components/RecoveryLogin.tsx` — no-Google proposal/start/countdown/finalization flow.
- `apps/web/recovery.html` and `apps/web/src/recovery.tsx` — a small independently buildable recovery entrypoint containing only `RecoveryLogin` and native-send-after-finalization state.

### Files to update

- `apps/web/src/App.tsx` — restore/read recovery state; add setup, pending cancellation, recovered-owner state, and polling lifecycle without moving QR logic into `App.tsx`.
- `apps/web/src/components/Onboarding.tsx` — add the secondary **Recover with passport** action.
- `apps/web/src/components/WalletView.tsx` — render the recovery view model/banner around the existing balance and native Send UI. Do not create a migrate-funds control.
- `apps/web/src/aa/client.ts` — retain the existing ZeroDev sponsorship callback for every V2 adapter and make address-based recovery account construction explicit.
- `apps/web/src/lib/types.ts`, `lib/session.ts`, and `lib/utils.ts` — add recovery view/state types and scoped local-storage parsing/validation.
- `apps/web/src/style.css` — banner, delay chooser, QR card, recovery countdown, unsafe-state, and destructive-forget styles matching existing UI patterns.
- `apps/web/vite.config.ts` — expose the `recovery.html` entry in the production build.

### Local recovery key

Generate the proposed owner with the existing `viem/accounts` `generatePrivateKey()` path. Store only the raw key in:

```text
zklogin.recovery.<chainId>.<kernelAddress>.<recoveryNonce>
```

Validate its byte length before use. Never render, copy, download, export, synchronize, or send it to a backend.

- Delete it when its proposal is cancelled or replaced.
- Keep it after finalization so the native Send UI can work.
- In recovered state, hide ordinary Disconnect. Add **Forget recovery key** only after an irreversible confirmation that says the wallet must already be empty; then delete the local-storage entry and clear local recovered state.
- If a recovery screen has no matching local key for a pending proposal, it shows **Start a new recovery**. It must never claim that it can complete the existing proposal from another browser/origin.

### Dashboard flows and copy

#### Guardian absent

Above the balance card:

> **Make this wallet recoverable**
>
> Add your passport as a recovery guardian. If Google access stops working, your passport can propose a local replacement owner. You choose how long recovery waits.
>
> **Add passport recovery**

Setup steps:

1. **Choose recovery time** — selectable cards: Immediate, 1 day, 3 days, 7 days, 30 days. Select 7 days initially.
2. **Scan your passport** — render the shared QR proof. State: “Your passport proves recovery eligibility without adding passport details to this wallet.”
3. **Confirm** — show the selected wait. For Immediate, show: “Immediate recovery has no reliable cancellation window. Anyone able to use your enrolled passport can immediately replace the owner.” Require an extra confirmation checkbox.

The final button is **Make wallet recoverable**. It submits one normal sponsored UserOperation to `setGuardian`.

#### Guardian ready and rotation

Show:

> **Passport recovery ready** · Recovery waits **[selected delay]**
>
> **Replace passport** · **Remove passport recovery**

Rotation opens the same setup card, preselecting the current delay. The new proof and selected delay replace the old guardian immediately after confirmation. Removal requires:

> Removing passport recovery means Google is the only way back after this session ends. **Remove passport recovery**

#### Recovery pending during normal login

Read public recovery state before ready dashboard render. If a proposal is active, show a persistent banner:

> **Recovery is in progress**
>
> A passport recovery can replace this wallet owner after **[absolute date and time]**. Your wallet still works. If this was not you, cancel recovery now.
>
> **Cancel recovery**

Show proposed owner, request time, selected delay, and executable time. Never show a passport identity.

Cancellation asks:

> Keep passport recovery for later?
>
> **Keep recovery** · **Remove passport recovery too**

- Keep recovery: sponsored `cancelRecovery()`.
- Remove too: one sponsored batch of `cancelRecovery()` and `clearGuardian()`.

For a non-immediate proposal, ordinary native Send remains enabled. For Immediate, the proposal is normally finalized immediately and the pending state is transient; do not promise a cancellation opportunity.

#### Unsafe recovered owner

After local-owner finalization, keep existing balance and Send controls. Add a persistent warning:

> **Unsafe recovery owner**
>
> This wallet is controlled by an unsafe browser-only owner key. Use Send to move funds to a safer wallet as soon as possible. Clearing this browser before you move funds can permanently lose access.

Do not add Google re-enrollment, guardian management, a migration shortcut, or ordinary disconnect to this state.

### Recovery-login flow

`RecoveryLogin` is available from normal onboarding and the independent recovery entrypoint. It never needs a Google JWT.

1. **Wallet address** — checksum validate, read V2 state, and require active passport recovery. If no guardian is enrolled, show “This wallet has no passport recovery.”
2. **Generate local owner** — generate and store the local recovery key under the next recovery nonce. Show only its address and a warning that it is temporary/browser-local; never expose the key.
3. **Passport proof** — render `PassportProofRequest` for `PROPOSE_RECOVERY`, the wallet, generated owner, and next nonce.
4. **Start recovery** — create mode-`0x02` exact proposal UserOperation and submit through the existing sponsored client.
5. **Waiting** — show the selected deadline. Before deadline, no completion action exists.
6. **Complete recovery** — at/after deadline, use the stored proposed local key to make a mode-`0x03` exact finalization UserOperation through sponsorship.
7. **Recovered** — instantiate mode-`0x04` client for the same known deployed Kernel address and render the existing balance/native-send UI with the unsafe banner.

If a different compatible recovery app/browser starts recovery, it has its own local storage and owner key. It intentionally replaces the existing proposal and restarts the selected delay. The static recovery artifact must document this limitation.

## Polling and transaction handling

Chain reads are authoritative. Local countdowns are presentation only.

| Surface | Required behavior |
|---|---|
| Normal dashboard, no proposal | Read recovery state on login/restore, after each recovery receipt, and every 60 seconds while visible. |
| Dashboard/recovery flow, active proposal | Read immediately and every 15 seconds while visible. Render a one-second countdown from last confirmed `executableAt`. |
| Address lookup | Read on submit and explicit refresh. Once a proposal exists, use the 15-second schedule. |
| Submitted UserOperation | Use existing `waitForSuccess`, then refresh public recovery state immediately. On receipt timeout/error, show the UserOperation hash and keep polling; do not claim success or failure from local state alone. |
| ZKPassport QR | Use QR SDK callbacks only. Do not create a parallel QR poll loop. |

Pause interval reads while `document.visibilityState !== "visible"`; refresh once when visible again. Disable each state-changing control until its UserOperation receipt and corresponding state refresh complete. A countdown reaching zero never enables finalization until a fresh on-chain read confirms the proposal and the contract validates it.

## Unit-test plan

Add focused unit coverage only. Use a local mock of ZKPassport root verifier/helper; do not require a real passport, SDK bridge, public RPC, deployed verifier, browser, or a seven-day wait.

### Solidity

Add `contracts/test/ZkLoginKernelValidatorV2.t.sol` and helpers covering:

- accepted/rejected delay values and default handling supplied by frontend;
- guardian setup/rotation/removal; no active-proposal guardian replacement/removal;
- every ZKPassport rejection: invalid proof, dev mode, domain, scope, sender/wallet binding, chain binding, seven-day validity parameter, face-match, custom binding, and guardian nullifier mismatch;
- exact mode-`0x02` proposal calldata and proof-to-calldata identity; changed owner/nonce/action/wallet/proof fails;
- proposal replacement and deadline calculation for all five delays;
- mode-`0x03` rejects before deadline, wrong key, wrong nonce, and arbitrary call data;
- finalized owner mode `0x04`, proposal clearing, Google/session behavior before finalization, and Google/session rejection after finalization;
- normal cancellation and cancellation-plus-clear batch semantics;
- proof that passport recovery cannot transfer assets or authorize arbitrary Kernel calls.

### TypeScript

Add unit tests for:

- canonical binding encoding, fixed domain/scope/validity/chain inputs, and allowed delays;
- recovery state decoding and local-key validation/storage lifecycle;
- exact calldata builder selection for modes `0x02`–`0x04`;
- banner/cancellation/recovery-flow state transitions, countdown boundaries, and visibility-aware poll scheduling;
- immediate-delay warning and lack of a cancellation guarantee; and
- recovered unsafe state retaining native Send without an added migrate action.

Run only the existing unit-test command, typecheck, and build as the implementation verification commands.

## Implementation order

1. Cut the network configuration and generated deployment schema to Sepolia; make all existing typecheck/build callers use it.
2. Pin ZKPassport dependencies/remapping and implement the isolated ZKPassport proof wrapper plus parser types.
3. Implement V2 contract, mocks, deployment script, contract unit tests, and deployment metadata verification.
4. Implement V2 custom validator adapters and Sepolia-sponsored account/client construction.
5. Implement recovery state reader, bindings, local-key lifecycle, and polling primitives.
6. Integrate dashboard setup/rotation/removal/pending/unsafe surfaces while preserving existing Send UI.
7. Implement onboarding recovery route and separate static recovery entrypoint.
8. Update configuration documentation and run unit tests, typecheck, and build.

## Explicit non-goals

- Third-party guardians, multi-guardian thresholds, voting, or social recovery.
- User-visible private-key export, backup phrases, cloud sync, or cross-origin local-storage access.
- Per-wallet passport scopes or cross-wallet unlinkability.
- Domain-origin hardening for ZKPassport recovery.
- Google re-enrollment or guardian management after local-owner finalization.
- WalletConnect, arbitrary connector support, ERC-20 recovery UI, external relayers, or alternative paymaster implementation in this app.
- Live, browser, E2E, manual, public-chain, or real-passport test gates.
