# TODOS

## Contract

- [ ] **Bundle session activation with first send in one UserOp.** Currently the validator's `_isExactActivation` (ZkLoginKernelValidator.sol:221–236) enforces a strict `keccak256` match on `callData` — proof-mode UserOps can only encode `execute(0, abi.encodePacked(validator, 0, activateSession(...)))`. This means activation is always a standalone transaction. Relax the check to accept a batch where the first call is `activateSession` with matching params, so the proof-mode UserOp can also carry the first ETH transfer. Requires: modify contract, re-run Foundry tests, redeploy to Base Sepolia, update `deployment.json`, wire frontend to batch.
