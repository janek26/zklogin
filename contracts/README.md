# Contracts

Install Foundry and then initialize the pinned test dependencies:

```sh
forge install foundry-rs/forge-std@v1.9.7 OpenZeppelin/openzeppelin-contracts@v5.6.1
forge fmt --check
forge build
forge test
```

Deploy only after a frozen JWK snapshot and app ID have been generated. The
deployer private key must never be placed in browser configuration or Git.
