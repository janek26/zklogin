import {
  Zkp2pClient,
  apiGetQuotesBestByPlatform,
  getContracts,
  Currency,
} from '@zkp2p/sdk'
import {
  createWalletClient,
  http,
  type Address,
  type Hex,
  type Hash,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'

const BASE_API = 'https://api.zkp2p.xyz'
const { addresses } = getContracts(base.id, 'production')
const USDC_BASE = addresses.usdc!
const ESCROW_ADDRESSES = addresses.escrowAddresses!

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

const clientCache = new Map<Hex, Zkp2pClient>()

function getOrCreateClient(sessionPrivateKey: Hex): Zkp2pClient {
  const cached = clientCache.get(sessionPrivateKey)
  if (cached) return cached

  const account = privateKeyToAccount(sessionPrivateKey)
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(),
  })

  const client = new Zkp2pClient({
    walletClient,
    chainId: base.id,
    runtimeEnv: 'production',
    baseApiUrl: BASE_API,
  })

  clientCache.set(sessionPrivateKey, client)
  return client
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

type QuotesRequest = Parameters<typeof apiGetQuotesBestByPlatform>[0]

export interface OnrampQuote {
  tokenAmount: bigint
  fiatCents: number
  platform: string
  paymentMethod: string
  depositId: string
  processorName: string
  payeeDetails: string
  conversionRate: bigint
}

export async function fetchBestQuote(
  fiatCents: number,
  processorName: string,
  walletAddress: Address,
): Promise<OnrampQuote> {
  const req: QuotesRequest = {
    amount: String(fiatCents * 10000),
    fiatCurrency: Currency.USD,
    destinationToken: USDC_BASE,
    destinationChainId: base.id,
    user: walletAddress,
    recipient: walletAddress,
    escrowAddresses: ESCROW_ADDRESSES,
  }

  const response = await apiGetQuotesBestByPlatform(req, BASE_API)
  const platformQuotes: Array<{
    platform: string
    available: boolean
    bestQuote?: {
      tokenAmount: string
      conversionRate: string
      paymentMethod: string
      intent?: {
        depositId: number | string
        processorName: string
        payeeDetails: string
      }
    }
  }> = (response as { responseObject?: { platformQuotes?: typeof platformQuotes } }).responseObject?.platformQuotes ?? []

  // Find the best quote for the requested platform
  let bestMatch: typeof platformQuotes[number] | null = null
  const availableNames: string[] = []

  for (const pq of platformQuotes) {
    if (pq.available) availableNames.push(pq.platform)
    if (pq.platform !== processorName) continue
    if (!pq.available || !pq.bestQuote || !pq.bestQuote.intent) continue
    // Use this if it's the first match or has a better rate
    if (!bestMatch || BigInt(pq.bestQuote.tokenAmount) > BigInt(bestMatch.bestQuote!.tokenAmount)) {
      bestMatch = pq
    }
  }

  if (bestMatch) {
    const q = bestMatch.bestQuote!
    return {
      tokenAmount: BigInt(q.tokenAmount ?? '0'),
      fiatCents,
      platform: bestMatch.platform,
      paymentMethod: q.paymentMethod ?? bestMatch.platform,
      depositId: String(q.intent!.depositId),
      processorName: q.intent!.processorName ?? bestMatch.platform,
      payeeDetails: q.intent!.payeeDetails ?? '',
      conversionRate: BigInt(q.conversionRate),
    }
  }

  const hint = availableNames.length
    ? ` Available: ${availableNames.join(', ')}.`
    : ''
  throw new Error(`${processorName} has no liquidity for $${(fiatCents / 100).toFixed(2)}.${hint}`)
}


/** Quick availability check — returns set of platform names with liquidity. */
export async function fetchAvailablePlatforms(walletAddress: Address): Promise<Set<string>> {
  const req: QuotesRequest = {
    amount: String(10 * 100 * 10000), // $10 to check availability
    fiatCurrency: Currency.USD,
    destinationToken: USDC_BASE,
    destinationChainId: base.id,
    user: walletAddress,
    recipient: walletAddress,
    escrowAddresses: ESCROW_ADDRESSES,
  }

  try {
    const response = await apiGetQuotesBestByPlatform(req, BASE_API)
    const platformQuotes: Array<{ platform: string; available: boolean }> =
      (response as { responseObject?: { platformQuotes?: typeof platformQuotes } }).responseObject?.platformQuotes ?? []
    return new Set(platformQuotes.filter(pq => pq.available).map(pq => pq.platform))
  } catch {
    return new Set()
  }
}
// ---------------------------------------------------------------------------
// Intent lifecycle
// ---------------------------------------------------------------------------
export async function signalOnrampIntent(
  sessionPrivateKey: Hex,
  walletAddress: Address,
  quote: OnrampQuote,
): Promise<Hash> {
  const client = getOrCreateClient(sessionPrivateKey)
  try {
    // Prepare the transaction WITHOUT gas estimation. The wallet has no ETH
    // on Base, so estimation would fail. Use a fixed gas limit instead.
    const prepared = await client.signalIntent.prepare({
      depositId: BigInt(quote.depositId),
      processorName: quote.processorName,
      payeeDetails: quote.payeeDetails,
      amount: BigInt(quote.fiatCents * 10000),
      fiatCurrencyCode: Currency.USD,
      conversionRate: quote.conversionRate,
      toAddress: walletAddress,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (client.walletClient as any).sendTransaction({
      account: client.walletClient.account!,
      to: prepared.to,
      data: prepared.data,
      value: prepared.value ?? 0n,
      gas: 500000n,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('tier') || msg.includes('PLUS') || msg.includes('PRO') || msg.includes('PLATINUM') || msg.includes('PEER')) {
      throw new Error(`${quote.platform} requires a higher taker tier. Try Venmo, Revolut, or Wise instead.`)
    }
    throw err
  }
}

export async function fulfillOnrampIntent(
  sessionPrivateKey: Hex,
  intentHash: Hash,
  proof: {
    proofType: 'buyerTee'
    encryptedSessionMaterial: string
    params: Record<string, string | number | boolean>
    actionPlatform: string
    actionType: string
  },
): Promise<void> {
  const client = getOrCreateClient(sessionPrivateKey)
  await client.fulfillIntent({
    intentHash,
    proof,
    attestationServiceUrl: 'https://attestation.zkp2p.xyz',
    timestampBufferMs: '300000',
  })
}
