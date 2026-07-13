# Contracts

Run the repository-level contract integration suite first:

```sh
pnpm test:contracts
```

It compiles and deploys the validator to an in-memory EVM and executes proof,
Merkle/JWK, nonce, exact-activation, EIP-191, session, expiry-data, ERC-1271,
and uninstall assertions. It deliberately uses a strict mock verifier; a real
UltraVerifier/Base Sepolia proof is a separate release gate.

Install Foundry to run the complementary Solidity suite and deployment script:

```sh
forge install foundry-rs/forge-std@v1.9.7 OpenZeppelin/openzeppelin-contracts@v5.6.1
forge fmt --check
forge build
forge test
```

Deploy only after a frozen JWK snapshot and app ID have been generated. The
deployer private key must never be placed in browser configuration or Git.
