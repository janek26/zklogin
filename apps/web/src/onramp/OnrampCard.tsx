import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatUnits, type Address, type Hex } from 'viem'
import { base } from 'viem/chains'
import { ONRAMP_CHAIN_ID, ONRAMP_CHAIN_NAME, ONRAMP_AMOUNTS, type OnrampAmount, type OnrampStage } from './types'
import { detectCountry, countryFlag, orderedPlatforms, type PlatformMeta } from './providers'
import {
  checkPeerState,
  requestPeerConnection,
  openPeerInstall,
  ensurePeerReady,
  startBuyerTeeCapture,
  type BuyerTeeProof,
  type PeerState,
} from './peer'
import { fetchBestQuote, fetchAvailablePlatforms, signalOnrampIntent, fulfillOnrampIntent, type OnrampQuote } from './client'
import { config } from '../config'

const ATTESTATION_SERVICE_URL = 'https://attestation.zkp2p.xyz'
const CHAIN_MISMATCH = (config.chainId as number) !== ONRAMP_CHAIN_ID

// ---- Extension install card (no extension detected) ----

function ExtensionInstallCard({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="onramp-ext-install">
      <div className="onramp-ext-icon" aria-hidden="true">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#b6ff6e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </div>
      <h3>One install, zero data shared</h3>
      <p>
        To verify your payment privately, you need the <strong>Peer</strong> browser extension.
        It captures a cryptographic receipt from { }your payment app — without ever
        seeing your password or balance.
      </p>
      <ul className="onramp-ext-features">
        <li>No account &middot; no registration</li>
        <li>No KYC &middot; no identity check</li>
        <li>Your credentials never leave your device</li>
        <li>Open source &middot; audited by Trail of Bits</li>
      </ul>
      <button className="primary-button" onClick={() => openPeerInstall()}>
        Install Peer Extension
      </button>
      <button className="text-button" onClick={onRetry}>
        I've installed it — check again
      </button>
    </div>
  )
}

// ---- Extension connect card (installed but not connected) ----

function ExtensionConnectCard({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="onramp-ext-connect">
      <div className="onramp-ext-icon" aria-hidden="true">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#b6ff6e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0110 0v4" />
        </svg>
      </div>
      <h3>Allow this site to use Peer</h3>
      <p>
        Peer is installed but needs your permission to connect to this site.
        Click below and approve the connection prompt.
      </p>
      <button className="primary-button" onClick={onConnect}>
        Connect Peer
      </button>
    </div>
  )
}

// ---- Main component ----

export function OnrampCard({
  walletAddress,
  sessionPrivateKey,
  collapsed = false,
}: {
  walletAddress: Address
  sessionPrivateKey: Hex
  collapsed?: boolean
}) {
  const [stage, setStage] = useState<OnrampStage>('extension_check')
  const [userExpanded, setUserExpanded] = useState(false)
  const [platform, setPlatform] = useState<PlatformMeta | null>(null)
  const [quote, setQuote] = useState<OnrampQuote | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedAmount, setSelectedAmount] = useState<OnrampAmount | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  const country = useMemo(() => detectCountry(), [])
  const platforms = useMemo(() => orderedPlatforms(), [])
  const [availablePlatforms, setAvailablePlatforms] = useState<Set<string> | null>(null)

  const sortedPlatforms = useMemo(() => {
    if (!availablePlatforms) return platforms
    const available = platforms.filter(p => availablePlatforms.has(p.id))
    const unavailable = platforms.filter(p => !availablePlatforms.has(p.id))
    return [...available, ...unavailable]
  }, [platforms, availablePlatforms])

  useEffect(() => { return () => { unsubscribeRef.current?.() } }, [])
  useEffect(() => { if (collapsed) setUserExpanded(false) }, [collapsed])

  const expanded = !collapsed || userExpanded

  useEffect(() => {
    if (stage === 'idle' && expanded && !platform && !availablePlatforms) {
      fetchAvailablePlatforms(walletAddress).then(setAvailablePlatforms)
    }
  }, [stage, expanded, platform, availablePlatforms, walletAddress])


  // -----------------------------------------------------------------------
  // Extension check on mount
  // -----------------------------------------------------------------------

  const doExtensionCheck = useCallback(async () => {
    setError(null)
    setStage('extension_check')
    try {
      const state: PeerState = await checkPeerState()
      if (state === 'needs_install') {
        setStage('extension_install')
      } else if (state === 'needs_connection') {
        setStage('extension_connect')
      } else {
        setStage('idle')
      }
    } catch {
      setStage('extension_install')
    }
  }, [])

  useEffect(() => {
    void doExtensionCheck()
  }, [doExtensionCheck])

  const handleConnect = useCallback(async () => {
    try {
      const ok = await requestPeerConnection()
      if (ok) setStage('idle')
      else setError('Connection was declined. Peer needs permission to verify payments.')
    } catch {
      setError('Could not connect to Peer.')
    }
  }, [])

  // -----------------------------------------------------------------------
  // Fetch quote
  // -----------------------------------------------------------------------

  const pickAmount = useCallback(async (amount: OnrampAmount) => {
    if (!platform) return
    setSelectedAmount(amount)
    setError(null)
    setStage('fetching')
    try {
      const q = await fetchBestQuote(amount * 100, platform.id, walletAddress)
      setQuote(q)
      setStage('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch quote')
      setStage('error')
    }
  }, [platform, walletAddress])

  // -----------------------------------------------------------------------
  // Start payment
  // -----------------------------------------------------------------------

  const startPayment = useCallback(async () => {
    if (!quote || !selectedAmount || !platform) return
    setError(null)
    setStage('paying')
    try {
      await ensurePeerReady()
      const intentHash = await signalOnrampIntent(sessionPrivateKey, walletAddress, quote)
      unsubscribeRef.current = startBuyerTeeCapture({
        config: platform.buyerTee,
        attestationServiceUrl: ATTESTATION_SERVICE_URL,
        onCapture: async (proof: BuyerTeeProof) => {
          try {
            setStage('fulfilling')
            await fulfillOnrampIntent(sessionPrivateKey, intentHash, proof)
            setTxHash(intentHash)
            setStage('done')
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Fulfillment failed')
            setStage('error')
          }
        },
        onError: (err) => { setError(err.message); setStage('error') },
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment flow failed')
      setStage('error')
    }
  }, [quote, selectedAmount, sessionPrivateKey, walletAddress, platform])

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------

  const reset = useCallback(() => {
    unsubscribeRef.current?.(); unsubscribeRef.current = null
    setStage('idle'); setPlatform(null); setQuote(null)
    setError(null); setSelectedAmount(null); setTxHash(null)
  }, [])

  const backToProviders = useCallback(() => {
    unsubscribeRef.current?.(); unsubscribeRef.current = null
    setStage('idle'); setPlatform(null); setQuote(null)
    setError(null); setSelectedAmount(null); setTxHash(null)
  }, [])

  const formatUsdc = (amount: bigint) => {
    const s = formatUnits(amount, 6)
    const dot = s.indexOf('.')
    return dot >= 0 ? s.slice(0, dot + 5) : s
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const extStages = stage === 'extension_check' || stage === 'extension_install' || stage === 'extension_connect'
  const showHeader = expanded && !extStages && stage !== 'done' && stage !== 'error'

  return (
    <section className={`onramp-card card${!expanded ? ' is-collapsed' : ''}`}>
      {showHeader && (
      <div className="card-header">
        <div>
          <p className="eyebrow">Add ETH</p>
          <h2>No KYC &middot; 3 clicks</h2>
        </div>
        {platform && <span className="onramp-badge">{platform.label}</span>}
      </div>
      )}

      {expanded && !extStages && CHAIN_MISMATCH && stage !== 'done' && stage !== 'error' && (
        <p className="onramp-chain-note">
          ETH arrives on {ONRAMP_CHAIN_NAME}. Bridge to {config.chain.name} after.
        </p>
      )}

      {/* ---- extension check (loading) ---- */}
      {stage === 'extension_check' && (
        <div className="onramp-status">
          <span className="button-spinner" />
          Checking for Peer extension&hellip;
        </div>
      )}

      {/* ---- extension not installed ---- */}
      {stage === 'extension_install' && (
        <ExtensionInstallCard onRetry={() => void doExtensionCheck()} />
      )}

      {/* ---- extension needs connection ---- */}
      {stage === 'extension_connect' && (
        <ExtensionConnectCard onConnect={() => void handleConnect()} />
      )}

      {/* ---- collapsed ---- */}
      {stage === 'idle' && !expanded && (
        <button className="onramp-collapsed-trigger" onClick={() => setUserExpanded(true)}>
          <span className="onramp-collapsed-icon">+</span>
          <span>Add ETH &mdash; no KYC, 3 clicks</span>
        </button>
      )}

      {/* ---- provider selector ---- */}
      {stage === 'idle' && expanded && !platform && (
        <>
        {country && (
          <div className="onramp-country">
            <span className="onramp-country-flag">{countryFlag(country)}</span>
            <span>{new Intl.DisplayNames(['en'], { type: 'region' }).of(country) ?? country}</span>
          </div>
        )}
        <div className="onramp-providers">
          {sortedPlatforms.map((p) => {
            const isAvail = !availablePlatforms || availablePlatforms.has(p.id)
            return (
              <button
                key={p.id}
                className={`onramp-provider-btn${!isAvail ? ' is-unavailable' : ''}`}
                onClick={() => isAvail && setPlatform(p)}
                disabled={!isAvail}
              >
                <span className="onramp-provider-label">
                  {p.label}
                  {!isAvail && <span className="onramp-provider-tag">Unavailable</span>}
                </span>
                <span className="onramp-provider-desc">{p.description}</span>
              </button>
            )
          })}
        </div>
        </>
      )}
      {/* ---- amount selector ---- */}
      {stage === 'idle' && expanded && platform && (
        <div className="onramp-amounts">
          {ONRAMP_AMOUNTS.map((amt) => (
            <button key={amt} className="onramp-amount-btn" onClick={() => void pickAmount(amt)}>
              <span className="onramp-amount-value">${amt}</span>
            </button>
          ))}
          <button className="text-button onramp-back" onClick={backToProviders}>Change provider</button>
        </div>
      )}

      {/* ---- fetching ---- */}
      {stage === 'fetching' && (
        <div className="onramp-status"><span className="button-spinner" />Finding best rate&hellip;</div>
      )}

      {/* ---- ready ---- */}
      {stage === 'ready' && quote && (
        <div className="onramp-confirm">
          <div className="onramp-quote">
            <span className="onramp-quote-label">You send via {platform?.label}</span>
            <span className="onramp-quote-value">${selectedAmount}.00</span>
          </div>
          <div className="onramp-arrow">&darr;</div>
          <div className="onramp-quote">
            <span className="onramp-quote-label">You receive</span>
            <span className="onramp-quote-value">{formatUsdc(quote.tokenAmount)} USDC</span>
            <span className="onramp-quote-chain">on {ONRAMP_CHAIN_NAME}</span>
          </div>
          <button className="primary-button onramp-buy-btn" onClick={() => void startPayment()}>
            Buy with {platform?.label}
          </button>
          <button className="text-button" onClick={backToProviders}>Cancel</button>
        </div>
      )}

      {/* ---- paying / fulfilling ---- */}
      {stage === 'paying' && (
        <div className="onramp-status">
          <span className="button-spinner" />
          <div>
            <strong>Complete your ${selectedAmount}.00 payment</strong>
            <p className="onramp-hint">The Peer extension opened {platform?.label}. Send the payment shown there.</p>
          </div>
        </div>
      )}
      {stage === 'fulfilling' && (
        <div className="onramp-status"><span className="button-spinner" />Confirming on-chain&hellip;</div>
      )}

      {/* ---- done ---- */}
      {stage === 'done' && (
        <div className="onramp-done">
          <div className="onramp-check" aria-hidden="true">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#b6ff6e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <p>${selectedAmount}.00 sent via {platform?.label}. USDC is on its way on {ONRAMP_CHAIN_NAME}.</p>
          {txHash && (
            <a className="onramp-tx-link" href={`${base.blockExplorers.default.url}/tx/${txHash}`} target="_blank" rel="noopener noreferrer">View on BaseScan</a>
          )}
          <button className="text-button" onClick={reset}>Add more</button>
        </div>
      )}

      {/* ---- error ---- */}
      {stage === 'error' && error && (
        <div className="alert compact" role="alert">
          <strong>Onramp issue</strong>
          <span>{error}</span>
          <button className="text-button" onClick={backToProviders}>Try again</button>
        </div>
      )}
    </section>
  )
}
