# Onramp — parked

Branch: `feature/onramp-peer-buyer-tee`

## What was built

A fiat-to-crypto onramp integrated into the zkLogin wallet. Uses ZKP2P's
escrow protocol on Base with Peer browser extension for Buyer TEE payment
proof capture.

### Architecture

```
OnrampCard (React)
├── Extension detection (step 0)
│   ├── Not installed → Chrome Web Store install card
│   └── Installed → connect prompt → provider selection
├── Provider selection (11 platforms, country-ordered)
│   └── Availability pre-fetch via /v2/quote/best-by-platform
├── Quote fetch (live USDC rates, real escrow addresses)
└── Payment flow
    ├── signalIntent (prepare + manual send, 500k gas)
    ├── Peer extension Buyer TEE capture
    └── fulfillIntent (attestation → on-chain)
```

### Files

```
apps/web/src/onramp/
├── types.ts          # OnrampStage, ONRAMP_AMOUNTS, chain constants
├── providers.ts      # 11 platforms, BuyerTeeConfig, country detection + flag
├── peer.ts           # PeerExtensionSdk wrapper, capture flow, state checks
├── client.ts         # Zkp2pClient factory, quote fetch, signal/fulfill
└── OnrampCard.tsx    # Full state-machine UI component
```

### Key decisions

- **Base chain** (8453) — ZKP2P escrow contracts live here. Wallet runs on
  MegaETH testnet (6343). Chain mismatch warning shown.
- **USDC** — the protocol token, not ETH. Displayed in quote UI.
- **No `as any` on SDK methods** — `signalIntent`, `fulfillIntent` called
  typed. One unavoidable cast on API response shape.
- **Country-based provider ordering** — `navigator.language` → timezone
  fallback. US: Venmo first, EU: Revolut first, LATAM: Mercado Pago first.
  Flag emoji + region name displayed.
- **Provider availability pre-fetch** — calls `/v2/quote/best-by-platform`
  when provider list renders. Unavailable platforms dimmed + tagged.
  Available platforms sort to top.
- **No gas estimation** — `signalIntent` uses `.prepare()` + manual
  `sendTransaction` with fixed 500k gas limit. The wallet has 0 ETH on Base
  so viem's `estimateGas` would fail.

---

## Challenges — why this is parked

### 1. SDK-server version mismatch

The `@zkp2p/sdk` 0.8.1 (latest) is out of sync with `api.zkp2p.xyz`.
The SDK type `QuotesBestByPlatformRequest` has 6 required fields, but the
server requires a 7th: `escrowAddresses`. The field is marked optional in
the TS type but mandatory at runtime.

**Discovery:** `Zkp2pClient.getQuotesBestByPlatform()` auto-injects
`escrowAddresses` from client config, but the raw `apiGetQuotesBestByPlatform()`
does not. We use the raw function (with explicit `escrowAddresses`) because
the client method isn't directly exported.

**Resolution:** Added `escrowAddresses` explicitly from `getContracts()`.
Works now. Will be unnecessary when SDK and server sync.

### 2. API amount unit

The `amount` field in `QuotesBestByPlatformRequest` uses 6-decimal fixed-point:
`1,000,000 = $1.00`. Not documented in the SDK. Discovered by testing.

**Resolution:** Multiply fiat cents by 10,000. e.g. $10.00 = 1000 cents →
10,000,000.

### 3. USDC, not ETH

The protocol exclusively uses USDC. WETH (`0x4200...0006`) is rejected
by the API. USDC on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.

**Resolution:** Switched to USDC. UI shows USDC amounts.

### 4. API availability vs on-chain tier gates

The `/v2/quote/best-by-platform` endpoint returns `available: true` for
platforms whose deposits have tier requirements the user doesn't meet.
PayPal's deposit (id 1444) requires PLUS tier but the API says available.
The contract rejects at `signalIntent` time with "PLUS tier required."

**Taker tier system:**
| Tier | Volume | Cap | Fee Discount |
|------|--------|-----|-------------|
| Peasant | 0 | $100 | 0% |
| Peer | $250 | $250 | 0.05% |
| Plus | $1,000 | $1,000 | 0.10% |
| Pro | $2,500 | $2,500 | 0.20% |
| Platinum | $5,000 | $5,000 | 0.30% |

**Platforms that work for fresh users (Peasant tier, $10 test):**
| Platform | USDC | Tier gate |
|----------|------|-----------|
| Venmo | 9.75 | None |
| Revolut | 7.33 | None |
| Wise | 7.79 | None |
| PayPal | 9.90 | PLUS required |
| N26 | — | No liquidity |
| Cash App | — | No liquidity |
| Zelle | — | No liquidity |
| Chime | — | No liquidity |
| Monzo | — | No liquidity |
| Mercado Pago | — | No liquidity |
| Luxon | — | No liquidity |

**Resolution:** Added tier-aware error messages. When `signalIntent` fails
with a tier revert, error says "X requires a higher taker tier. Try Venmo,
Revolut, or Wise instead." The API doesn't expose tier requirements per
deposit, so we can't filter proactively.

### 5. Zero ETH on Base for gas

The wallet's session signer has 0 ETH on Base (all funds on MegaETH testnet).
Viem's `estimateGas` fails before the transaction even reaches the mempool.

**Resolution:** `signalIntent` uses `.prepare()` to get the transaction
without estimation, then `walletClient.sendTransaction()` with a fixed
`gas: 500000n`. The user still needs ETH on Base for actual gas — this
just prevents the cryptic estimation failure. A future solution would
bridge ETH or use a Base gas sponsor.

### 6. Peer browser extension requirement

The Peer extension uses `chrome.webRequest` — an extension-only API that
no web platform API can replicate. It intercepts HTTPS traffic to payment
providers (Venmo, Revolut, etc.) to capture TLS-attested payment proofs.

**Alternatives researched:**
- **Mobile SDK** (`@zkp2p/zkp2p-react-native-sdk`): native WebView
  interception, no extension needed
- **Proxy approach** (Reclaim Protocol model): route traffic through a
  proxy that witnesses encrypted TLS data
- **Desktop app** (Electron/Tauri): embed a WebView, intercept its traffic
- **CDP** (Chrome DevTools Protocol): requires external process, not viable
  for consumer UX

**Resolution:** Extension detection is the first step in the onramp flow.
Beautiful install card with Chrome Web Store link + check-again button.
No fallback — the extension is required for desktop web.

### 7. API doesn't expose tier requirements per platform

The `getTakerTier` call exists but requires an on-chain RPC call. The
best-by-platform API response has no `minTierRequired` field per platform,
so we can't show which platforms the user can actually use before they
try. The only indicator is `available: true/false`, which is unreliable
(see challenge 4).

**Resolution:** We display availability from the API but accept that
some `available: true` platforms will fail at contract time. Tier errors
are caught and surfaced with alternatives.

---

## What's needed to un-park

1. **SDK update** — when `@zkp2p/sdk` releases a version that syncs with
   the API server (fixes `escrowAddresses` requirement, corrects amount
   units in docs, exposes tier requirements in quote responses)
2. **ETH on Base** — user needs a small amount of ETH on Base for gas.
   Either bridge from MegaETH testnet or use a paymaster/sponsor.
3. **Tier-aware filtering** — the API should return `minTierRequired` per
   platform so we can filter proactively instead of failing at contract time.
4. **Mobile path** — for mobile users who can't install browser extensions,
   the `@zkp2p/zkp2p-react-native-sdk` would need to be integrated.
5. **Provider availability stability** — 7 of 11 platforms have zero
   liquidity for fresh users. This may improve as more makers join the
   protocol.

## Commit history on this branch

All changes are uncommitted on `feature/onramp-peer-buyer-tee`.
