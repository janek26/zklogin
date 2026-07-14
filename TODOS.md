# TODOS

## Contract

- [ ] **Bundle session activation with first send in one UserOp.** Currently the validator's `_isExactActivation` (ZkLoginKernelValidator.sol:221–236) enforces a strict `keccak256` match on `callData` — proof-mode UserOps can only encode `execute(0, abi.encodePacked(validator, 0, activateSession(...)))`. This means activation is always a standalone transaction. Relax the check to accept a batch where the first call is `activateSession` with matching params, so the proof-mode UserOp can also carry the first ETH transfer. Requires: modify contract, re-run Foundry tests, redeploy to Base Sepolia, update `deployment.json`, wire frontend to batch.

## MegaETH Testnet (Chain 6343)

ZeroDev bundler, paymaster (native ETH sponsorship), EntryPoint 0.7, and Kernel v3.3 are all deployed and verified on-chain for chain 6343. SDK works out of the box (no upgrades). The main work is deploying our two contracts (UltraVerifier + ZkLoginKernelValidator) and wiring the frontend config.

### Phase 1 — Contract deployment

- [ ] **Add MegaETH RPC to `contracts/.env`.** Key: `MEGAETH_TESTNET_RPC_URL=https://carrot.megaeth.com/rpc`
- [ ] **Deploy UltraVerifier to chain 6343.** Source: `@shield-labs/zklogin-contracts@0.5.0` → `noir/target/jwt_account.sol` (2777 lines, standard Noir Groth16 verifier). Copy to `contracts/src/UltraVerifier.sol`, compile with forge, deploy. Same bytecode as Base Sepolia deployment (`runtimeCodeHash: 0xeb6c39…`).
- [ ] **Deploy ZkLoginKernelValidator to chain 6343.** Run `Deploy.s.sol` targeting chain 6343 with the new UltraVerifier address. Same `GOOGLE_JWK_ROOT` and `APP_ID` (chain-agnostic). Session nonce already includes `block.chainid` for cross-chain replay protection.
- [ ] **Verify both contracts on Etherscan** (`https://testnet-mega.etherscan.io`).
- [ ] **Fund deployer wallet with MegaETH testnet ETH** from [faucet](https://docs.megaeth.com/user-guide/faucet).

### Phase 2 — Frontend wiring

- [ ] **Create `apps/web/src/generated/deployment-megaeth.json`.** Same structure as Base Sepolia deployment. EntryPoint, Kernel implementation, and factory addresses are identical (deterministic). UltraVerifier and validator addresses from Phase 1.
- [ ] **Update `config.ts` for chain 6343.** Import `megaethTestnet` from `viem/chains` (already ships in viem 2.55.1). Switch `chain`, `chainId`, `publicRpcUrl`, `zeroDevRpcUrl` (suffix `/chain/6343`). Update deployment guard to accept chainId 6343.
- [ ] **Add `.env.local` key:** `VITE_MEGAETH_TESTNET_RPC_URL=https://carrot.megaeth.com/rpc`.
- [ ] **Update CSP** (if using deployment headers) to allow `https://carrot.megaeth.com` and ZeroDev RPC.

### Phase 3 — Verify

- [ ] **Run `pnpm verify` against chain 6343.** Typecheck, vitest, build, deployment assertions.
- [ ] **Test full flow:** Google sign-in → PROVING → ACTIVATING → READY → Send.
- [ ] **Release gates** (SETUP.md §5): tab reload, new-tab derivation, JWK snapshot-miss, session expiry, network inspection.

### Notes

- **No circuit changes, no SDK changes, no JWK snapshot changes.** The ZK proof, Google OAuth, and JWK root are entirely chain-agnostic.
- **ZeroDev UltraRelay is NOT available on MegaETH** (Base/Arbitrum/Optimism only). Native ETH paymaster sponsorship works if gas policies are configured in ZeroDev Dashboard.
- **FAST_POLLING_CHAIN_IDS** excludes MegaETH → receipt polling defaults to 1000ms instead of 200ms. Cosmetic, no functional impact.
