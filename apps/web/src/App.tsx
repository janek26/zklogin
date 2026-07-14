import { GoogleLogin } from '@react-oauth/google'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { Address, Hex } from 'viem'
import { formatEther, getAddress, isAddress, isHex, parseAbi, parseEther, size } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createWalletClients, entryPoint, kernelVersion, publicClient, waitForSuccess } from './aa/client'
import { makeActivationCallData, makeActivationInnerData, toZkLoginKernelValidator, type ProofAuth } from './aa/zkLoginValidator'
import { createPreLoginSession, type PreLoginSession } from './auth/nonce'
import { proveInBrowser } from './auth/prove'
import { validateGoogleCredential } from './auth/validateJwt'
import { config } from './config'

type Stage = 'PREPARING' | 'GOOGLE_READY' | 'PROVING' | 'ACTIVATING' | 'READY' | 'SENDING' | 'ERROR'
type Wallet = Awaited<ReturnType<typeof createWalletClients>>
type StoredReadySession = { version: 1; privateKey: Hex; sessionKey: Address; validUntil: number; randomness: Hex; accountId: Hex; kernelAddress: Address }
type SendAction = { type: 'SEND_START' } | { type: 'SEND_DONE' }

function sendReducer(_state: boolean, action: SendAction): boolean {
  return action.type === 'SEND_START'
}

const PRELOGIN_KEY = 'zklogin.prelogin.v1'
const READY_KEY = 'zklogin.ready.v1'
const validatorStateAbi = parseAbi(['function accountState(address kernel) view returns (bytes32 accountId,address sessionKey,uint48 sessionValidUntil)'])

function shortAddress(address: string) { return `${address.slice(0, 6)}…${address.slice(-4)}` }
function RefreshIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 4v6h6" /><path d="M3.5 16A9 9 0 1 0 2 12" /></svg> }
function formatExpiry(ts: number) { return new Date(ts * 1000).toLocaleString() }

function CopyIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg> }
function ArrowIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13" /><path d="m13 6 6 6-6 6" /></svg> }

function loadOrCreatePreLogin(): PreLoginSession {
  const raw = sessionStorage.getItem(PRELOGIN_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PreLoginSession
      if (Number.isInteger(parsed.preparedAt) && Number.isInteger(parsed.sessionValidUntil) && Math.floor(Date.now() / 1000) - parsed.preparedAt <= 300) return parsed
    } catch { /* regenerate */ }
  }
  const created = createPreLoginSession()
  sessionStorage.setItem(PRELOGIN_KEY, JSON.stringify(created))
  return created
}
function requireBytes32(name: string, value: string): asserts value is Hex { if (!isHex(value) || size(value) !== 32) throw new Error(`${name}_NOT_BYTES32`) }
function validStored(value: unknown): value is StoredReadySession {
  if (!value || typeof value !== 'object') return false
  const x = value as Record<string, unknown>
  return x.version === 1 && typeof x.privateKey === 'string' && size(x.privateKey as Hex) === 32 && typeof x.sessionKey === 'string' && isAddress(x.sessionKey) && typeof x.validUntil === 'number' && Number.isInteger(x.validUntil) && typeof x.randomness === 'string' && size(x.randomness as Hex) === 32 && typeof x.accountId === 'string' && size(x.accountId as Hex) === 32 && typeof x.kernelAddress === 'string' && isAddress(x.kernelAddress)
}
async function assertActivated(expected: { kernel: Address; accountId: Hex; sessionKey: Address; validUntil: number }) {
  const code = await publicClient.getCode({ address: expected.kernel })
  if (!code || code === '0x') throw new Error('KERNEL_NOT_DEPLOYED')
  const [accountId, sessionKey, validUntil] = await publicClient.readContract({ address: config.validatorAddress, abi: validatorStateAbi, functionName: 'accountState', args: [expected.kernel] })
  if (accountId.toLowerCase() !== expected.accountId.toLowerCase() || sessionKey.toLowerCase() !== expected.sessionKey.toLowerCase() || validUntil !== expected.validUntil) throw new Error('ACTIVATION_POSTCONDITION_FAILED')
}

function statusHeadline(stage: Stage) {
  if (stage === 'PROVING') return 'Creating your private proof'
  if (stage === 'ACTIVATING') return 'Activating your wallet'
  if (stage === 'SENDING') return 'Sending your transfer'
  if (stage === 'PREPARING') return 'Preparing a secure session'
  return 'Sign in with Google'
}

export function App() {
  const [stage, setStage] = useState<Stage>('PREPARING')
  const [preLogin, setPreLogin] = useState<PreLoginSession>(loadOrCreatePreLogin)
  const [wallet, setWallet] = useState<Wallet | null>(null)
  const [balance, setBalance] = useState<bigint>(0n)
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [userOpHash, setUserOpHash] = useState<Hex | null>(null)
  const [sessionExpiry, setSessionExpiry] = useState(0)
  const [proofProgress, setProofProgress] = useState(0)
  const [copied, setCopied] = useState(false)
  const [sending, sendDispatch] = useReducer(sendReducer, false)
  const [countdown, setCountdown] = useState('')
  const proofStart = useRef(0)
  const unsupported = !window.Worker || !window.WebAssembly || !window.crypto || typeof BigInt === 'undefined'
  const reset = useCallback(() => { sessionStorage.removeItem(READY_KEY); const fresh = createPreLoginSession(); sessionStorage.setItem(PRELOGIN_KEY, JSON.stringify(fresh)); setPreLogin(fresh); setWallet(null); setError(null); setStage('GOOGLE_READY') }, [])

  const refreshBalance = useCallback(async (address?: Address) => { const target = address ?? wallet?.account.address; if (target) setBalance(await publicClient.getBalance({ address: target })) }, [wallet])

  useEffect(() => {
    let cancelled = false
    async function restore() {
      const raw = sessionStorage.getItem(READY_KEY)
      if (!raw) { if (!cancelled) setStage('GOOGLE_READY'); return }
      try {
        const stored: unknown = JSON.parse(raw)
        if (!validStored(stored) || stored.validUntil <= Math.floor(Date.now() / 1000)) throw new Error('INVALID_STORED_SESSION')
        const signer = privateKeyToAccount(stored.privateKey)
        if (signer.address.toLowerCase() !== stored.sessionKey.toLowerCase()) throw new Error('STORED_SESSION_KEY_MISMATCH')
        const activationCallData = makeActivationCallData({ validatorAddress: config.validatorAddress, sessionKey: signer.address, sessionValidUntil: stored.validUntil, randomness: stored.randomness })
        const validator = await toZkLoginKernelValidator({ entryPoint, kernelVersion, chainId: config.chainId, validatorAddress: config.validatorAddress, accountId: stored.accountId, sessionSigner: signer, activationCallData })
        const restored = await createWalletClients(validator)
        if (restored.account.address.toLowerCase() !== stored.kernelAddress.toLowerCase()) throw new Error('KERNEL_ADDRESS_DERIVATION_MISMATCH')
        await assertActivated({ kernel: restored.account.address, accountId: stored.accountId, sessionKey: signer.address, validUntil: stored.validUntil })
        if (!cancelled) { setWallet(restored); setSessionExpiry(stored.validUntil); await refreshBalance(restored.account.address); setStage('READY') }
      } catch { if (!cancelled) reset() }
    }
    void restore(); return () => { cancelled = true }
  }, [refreshBalance, reset])

  const completeGoogleLogin = useCallback(async (jwt: string, session: PreLoginSession) => {
    try {
      if (Math.floor(Date.now() / 1000) - session.preparedAt > 300) throw new Error('PRELOGIN_EXPIRED_RETRY_GOOGLE')
      setError(null); setStage('PROVING')
      const claims = validateGoogleCredential(jwt, session.googleNonce)
      const browserProof = await proveInBrowser(jwt, session.googleNonce)
      requireBytes32('ACCOUNT_ID', browserProof.accountId); requireBytes32('PUBLIC_KEY_HASH', browserProof.publicKeyHash)
      if (browserProof.jwtIat !== claims.iat) throw new Error('JWT_IAT_MISMATCH')
      const signer = privateKeyToAccount(session.privateKey)
      if (signer.address.toLowerCase() !== session.sessionKey.toLowerCase()) throw new Error('STORED_SESSION_KEY_MISMATCH')
      const proofAuth: ProofAuth = { proof: browserProof.proof, jwtIat: BigInt(browserProof.jwtIat), publicKeyHash: browserProof.publicKeyHash, jwkProof: browserProof.jwkProof, sessionKey: signer.address, sessionValidUntil: session.sessionValidUntil, randomness: session.randomness }
      const activationCallData = makeActivationCallData({ validatorAddress: config.validatorAddress, sessionKey: signer.address, sessionValidUntil: session.sessionValidUntil, randomness: session.randomness })
      const validator = await toZkLoginKernelValidator({ entryPoint, kernelVersion, chainId: config.chainId, validatorAddress: config.validatorAddress, accountId: browserProof.accountId, sessionSigner: signer, activationCallData, proofAuth })
      const created = await createWalletClients(validator)
      const sdkCallData = await created.account.encodeCalls([{ to: config.validatorAddress, value: 0n, data: makeActivationInnerData({ sessionKey: signer.address, sessionValidUntil: session.sessionValidUntil, randomness: session.randomness }) }])
      if (sdkCallData.toLowerCase() !== activationCallData.toLowerCase()) throw new Error('KERNEL_CALL_ENCODING_DRIFT')
      setStage('ACTIVATING'); const hash = await created.kernelClient.sendUserOperation({ callData: activationCallData }); setUserOpHash(hash); await waitForSuccess(created.kernelClient, hash)
      await assertActivated({ kernel: created.account.address, accountId: browserProof.accountId, sessionKey: signer.address, validUntil: session.sessionValidUntil })
      sessionStorage.setItem(READY_KEY, JSON.stringify({ version: 1, privateKey: session.privateKey, sessionKey: signer.address, validUntil: session.sessionValidUntil, randomness: session.randomness, accountId: browserProof.accountId, kernelAddress: created.account.address } satisfies StoredReadySession))
      sessionStorage.removeItem(PRELOGIN_KEY); setWallet(created); setSessionExpiry(session.sessionValidUntil); await refreshBalance(created.account.address); setStage('READY')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'LOGIN_FAILED'); setStage('ERROR') }
  }, [refreshBalance])

  const doSend = useCallback(async () => {
    if (!wallet || sending) return
    const target = getAddress(recipient.trim())
    const value = parseEther(amount.trim())
    if (value <= 0n) return
    const current = await publicClient.getBalance({ address: wallet.account.address })
    if (value > current) { setError('INSUFFICIENT_NATIVE_BALANCE'); return }

    setError(null)
    sendDispatch({ type: 'SEND_START' })

    try {
      const started = Date.now()
      const hash = await wallet.kernelClient.sendUserOperation({ calls: [{ to: target, value, data: '0x' }] })
      setUserOpHash(hash)
      await waitForSuccess(wallet.kernelClient, hash)
      await refreshBalance()

      const elapsed = Date.now() - started
      if (elapsed < 3_000) await new Promise(r => window.setTimeout(r, 3_000 - elapsed))

      window.setTimeout(() => {
        sendDispatch({ type: 'SEND_DONE' })
        setRecipient('')
        setAmount('')
      }, 2_000)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'SEND_FAILED')
      sendDispatch({ type: 'SEND_DONE' })
    }
  }, [amount, recipient, refreshBalance, sending, wallet])

  useEffect(() => {
    if (stage !== 'PROVING') { setProofProgress(0); return }
    proofStart.current = Date.now()
    setProofProgress(0)
    const timer = setInterval(() => {
      const elapsed = Date.now() - proofStart.current
      setProofProgress(Math.min(elapsed / 65_000, 0.95))
    }, 100)
    return () => clearInterval(timer)
  }, [stage])

  useEffect(() => {
    if (!sessionExpiry) return
    const tick = () => {
      const rem = sessionExpiry - Math.floor(Date.now() / 1000)
      if (rem <= 0) { setCountdown('Expired'); return }
      const h = Math.floor(rem / 3600)
      const m = Math.floor((rem % 3600) / 60)
      const s = rem % 60
      setCountdown(h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`)
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [sessionExpiry])

  const copyAddress = useCallback(async () => {
    if (!wallet) return
    await navigator.clipboard.writeText(wallet.account.address)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_800)
  }, [wallet])

  if (unsupported) {
    return (
      <main className="app-shell">
        <section className="unsupported card">
          <h1>Unsupported browser</h1>
          <p>This wallet uses WebAssembly, Web Workers, Web Crypto, and BigInt to create proofs safely in your browser. Please use a modern browser.</p>
        </section>
      </main>
    )
  }

  const showProgress = stage === 'PROVING' || stage === 'ACTIVATING' || stage === 'PREPARING'
  const showGoogle = !showProgress && stage !== 'ERROR'
  const canSend = !sending && recipient.trim() && amount.trim()

  return (
    <main className="app-shell">
      <nav className="topbar" aria-label="Wallet navigation">
        <span className="topbar-title">zkLogin wallet</span>
        <div className="topbar-right">
          <span className="network-badge"><i /> Base Sepolia</span>
          {wallet && <button className="text-button" onClick={reset}>Disconnect</button>}
        </div>
      </nav>

      <section className={`wallet-frame ${wallet ? 'is-ready' : ''}`}>
        {!wallet && (
          <div className="onboarding card">
            <div className="card-meta">Local proof &middot; no custody</div>

            <div className="hero-copy">
              <h1>{statusHeadline(stage)}</h1>
              <p>
                {stage === 'PROVING' && 'Generating a zero-knowledge proof in your browser. This stays entirely local.'}
                {stage === 'ACTIVATING' && 'Deploying your smart account on Base Sepolia and activating your session key.'}
                {stage === 'PREPARING' && 'Generating an ephemeral session key and cryptographic nonce locally.'}
                {stage === 'GOOGLE_READY' && 'Google verifies your identity. A zero-knowledge proof is then created in your browser — nothing leaves this tab.'}
                {stage === 'ERROR' && 'Something went wrong. You can start a new session below.'}
              </p>
            </div>

            {showProgress && (
              <div className="progress-panel" aria-live="polite">
                {stage === 'PROVING' ? (
                  <svg className="progress-ring" viewBox="0 0 40 40" aria-hidden="true">
                    <circle className="progress-ring-track" cx="20" cy="20" r="16" fill="none" />
                    <circle className="progress-ring-fill-determinate" cx="20" cy="20" r="16" fill="none" strokeDasharray={100} strokeDashoffset={100 * (1 - proofProgress)} strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg className="progress-ring" viewBox="0 0 40 40" aria-hidden="true">
                    <circle className="progress-ring-track" cx="20" cy="20" r="16" fill="none" />
                    <circle className="progress-ring-fill" cx="20" cy="20" r="16" fill="none" />
                  </svg>
                )}
                <div>
                  <strong>
                    {stage === 'PROVING' && `Proving with Google (${Math.round(proofProgress * 100)}%)`}
                    {stage === 'ACTIVATING' && 'Submitting activation'}
                    {stage === 'PREPARING' && 'Generating session'}
                  </strong>
                  <span>Keep this tab open</span>
                </div>
              </div>
            )}

            {showGoogle && (
              <div className="google-slot">
                <GoogleLogin
                  nonce={preLogin.googleNonce}
                  theme="outline"
                  shape="pill"
                  size="large"
                  text="continue_with"
                  width="352"
                  onSuccess={(response) => {
                    if (!response.credential) { setError('GOOGLE_RETURNED_NO_ID_TOKEN'); return }
                    void completeGoogleLogin(response.credential, preLogin)
                  }}
                  onError={() => setError('GOOGLE_LOGIN_FAILED')}
                />
                <p>A single sign-in activates a 24-hour session.</p>
              </div>
            )}

            {error && (
              <div className="alert" role="alert">
                <strong>We couldn&rsquo;t continue.</strong>
                <span>{error}</span>
                <button className="text-button" onClick={reset}>Start a new session <ArrowIcon /></button>
              </div>
            )}

            <div className="trust-row">Google identity &middot; Browser proof &middot; Kernel account</div>
          </div>
        )}

        {wallet && (
          <div className="wallet-grid">
            <section className="balance-card card">
              <div className="card-header">
                <div>
                  <p className="eyebrow">Available balance</p>
                  <button className="address-button" onClick={() => void copyAddress()} title="Copy wallet address">
                    <span>{shortAddress(wallet.account.address)}</span>
                    <CopyIcon />
                  </button>
                </div>
                <button className="icon-button" onClick={() => void refreshBalance()} title="Refresh balance">
                  <RefreshIcon />
                </button>
              </div>
              <div className="balance-value">{formatEther(balance)}<span> ETH</span></div>
              <div className="balance-meta">
                <span><i /> Ready to send</span>
                <span>Session ends {formatExpiry(sessionExpiry)}</span>
              </div>
            </section>

            <section className="send-card card">
              <div className="card-header">
                <div>
                  <p className="eyebrow">Send</p>
                  <h2>Native ETH</h2>
                </div>
                <span className="asset-token">ETH</span>
              </div>
              <div className="field">
                <label htmlFor="recipient">Recipient</label>
                <input id="recipient" value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="0x1234…" autoComplete="off" spellCheck="false" />
              </div>
              <div className="field amount-field">
                <label htmlFor="amount">Amount</label>
                <div className="amount-input">
                  <input id="amount" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" inputMode="decimal" />
                  <span>ETH</span>
                </div>
              </div>
              <button
                className="primary-button"
                disabled={!canSend}
                onClick={() => void doSend()}
              >
                {sending ? <><span className="button-spinner" /> Sending&hellip;</> : <>Send <ArrowIcon /></>}
              </button>
              {error && (
                <div className="alert compact" role="alert">
                  <strong>Transfer needs attention</strong>
                  <span>{error}</span>
                </div>
              )}
            </section>
            <aside className="session-info">
              <div className="session-info-top">
                <svg viewBox="0 0 24 24" aria-hidden="true" width="13" height="13">
                  <path d="M12 2a5 5 0 0 1 5 5v3h1a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v3h6V7a3 3 0 0 0-3-3z" fill="currentColor" />
                </svg>
                Session key active
              </div>
              <div className="session-info-body">
                <svg className="session-ring" viewBox="0 0 40 40" aria-hidden="true">
                  <circle className="session-ring-track" cx="20" cy="20" r="16" fill="none" />
                  <circle className="session-ring-fill" cx="20" cy="20" r="16" fill="none" strokeDasharray={100} strokeDashoffset={100 * (1 - Math.max(1, Math.min(99, Math.round(((sessionExpiry - Math.floor(Date.now() / 1000)) / 86400) * 100))) / 100)} strokeLinecap="round" />
                </svg>
                <div className="session-countdown">{countdown || '—'}</div>
              </div>
              <p>Only this browser tab holds your temporary key. Closing it requires a new Google sign-in.</p>
            </aside>
          </div>
        )}
      </section>

      {userOpHash && (
        <div className="receipt" role="status">
          <span className="receipt-dot" />
          {sending || stage === 'ACTIVATING' ? 'UserOperation pending ' : 'Latest UserOperation confirmed '}
          <a href={`${config.chain.blockExplorers.default.url}/tx/${userOpHash}`} target="_blank" rel="noopener noreferrer">
            <code>{shortAddress(userOpHash)}</code>
          </a>
        </div>
      )}
      {copied && <div className="toast" role="status">Address copied</div>}

      <footer>Unaudited research POC</footer>
    </main>
  )
}
