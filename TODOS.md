# TODOS

## Contract

- [ ] **Bundle session activation with first send in one UserOp.** Currently
  the validator's `_isExactActivation` (ZkLoginKernelValidator.sol:221–236)
  enforces a strict `keccak256` match on `callData` — proof-mode UserOps can
  only encode `execute(0, abi.encodePacked(validator, 0, activateSession(...)))`.
  This means activation is always a standalone transaction. Relax the check to
  accept a batch where the first call is `activateSession` with matching params,
  so the proof-mode UserOp can also carry the first ETH transfer. Requires:
  modify contract, re-run Foundry tests, redeploy, update deployment JSON, wire
  frontend to batch.

## UI

- [ ] **Fix Google sign-in button layout jump.** The `@react-oauth/google`
  `GoogleLogin` component renders an empty placeholder div before Google's GSI
  script replaces it with an iframe. During the gap the layout shifts and the
  button flashes. A `containerProps` className was added with transparent
  background and `min-height: 40px` but the flash may still occur on slower
  connections. Consider: pre-loading the GSI script earlier, using a skeleton
  placeholder that matches the final button dimensions exactly, or wrapping the
  component in a container with fixed dimensions + opacity transition.

## Auth

- [ ] **Add user-controlled salt for account derivation.** Currently Shield Labs'
  `ZkLoginSdk.ts:165` hardcodes `salt = Fr.ZERO`, so every Google account maps to
  exactly one wallet (`accountId = pedersenHash(sub, aud, 0)`). Sui's zkLogin
  uses a user-provided salt → `pedersenHash(sub, aud, salt)` → multiple wallets
  per Google account, with salts stored on a salt service. To match Sui:
  1. Allow the user to provide or generate a salt during sign-up
  2. Store the salt (localStorage or a hosted salt service)
  3. Pass the salt into the Noir circuit for account derivation
  4. Update the validator contract if the account ID computation changes
  5. The salt service must be available on every login to re-derive the same
     wallet address. If the salt is lost, the wallet is unrecoverable.
