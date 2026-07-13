#!/usr/bin/env sh
set -eu

if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker is required for this Foundry gate. Install Docker, then rerun.' >&2
  exit 1
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

docker run --rm \
  --volume "$repo_root:/repo" \
  --workdir /repo/contracts \
  ghcr.io/foundry-rs/foundry:stable \
  sh -lc '
    if [ ! -d lib/forge-std ]; then
      forge install foundry-rs/forge-std@v1.9.7 \
        OpenZeppelin/openzeppelin-contracts@v5.6.1
    fi
    forge fmt --check
    forge build
    forge test -vvv
  '
