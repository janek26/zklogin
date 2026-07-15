import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { Address, Hex } from 'viem'
import { getAddress, isAddress, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createWalletClients, entryPoint, kernelVersion, publicClient, waitForSuccess } from './aa/client'
import { makeActivationCallData, makeActivationInnerData, toZkLoginKernelValidator, type ProofAuth } from './aa/zkLoginValidator'
import { validateGoogleCredential } from './auth/validateJwt'
import { config } from './config'
import { Onboarding } from './components/Onboarding'
import { WalletView } from './components/WalletView'
import type { Stage, Wallet } from './lib/types'
import { sendReducer } from './lib/reducer'
import { shortAddress, requireBytes32, READY_KEY, PRELOGIN_KEY } from './lib/utils'
import { loadOrCreatePreLogin, assertActivated } from './lib/session'
import type { PreLoginSession } from './auth/nonce'
import { proveInBrowser } from './auth/prove'
import { parseIdTokenFromFragment, clearFragment } from './auth/googleOAuth'

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
  const [spinning, setSpinning] = useState(false)
  const proofStart = useRef(0)
  const oauthHandled = useRef(false)
  const unsupported = !window.Worker || !window.WebAssembly || !window.crypto || typeof BigInt === 'undefined'
  const isMobile = (navigator.maxTouchPoints > 1 && window.matchMedia('(pointer: coarse)').matches)
    || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

function estimateProofMs(): number {
  const threads = navigator.hardwareConcurrency || 4
  // Multithreaded: 18 threads observed at ~7s warm / ~23s cold.
  // Single-threaded (no COI): observed ~47-67s.
  if (window.crossOriginIsolated) return Math.round(25_000 * Math.min(18, threads * 1.4) / threads)
  return 90_000
}

  const reset = useCallback(() => {
    sessionStorage.removeItem(READY_KEY)
    const fresh = loadOrCreatePreLogin()
    setPreLogin(fresh)
    setWallet(null)
    setError(null)
    setUserOpHash(null)
    setStage('GOOGLE_READY')
  }, [])

  const refreshBalance = useCallback(async (address?: Address) => {
    const target = address ?? wallet?.account.address
    if (target) setBalance(await publicClient.getBalance({ address: target }))
  }, [wallet])

  useEffect(() => {
    let cancelled = false
    async function restore() {
      const raw = sessionStorage.getItem(READY_KEY)
      if (!raw) { if (!cancelled) setStage('GOOGLE_READY'); return }
      try {
        const stored = JSON.parse(raw) as { version: number; privateKey: Hex; sessionKey: string; validUntil: number; randomness: Hex; accountId: Hex; kernelAddress: string }
        if (stored.version !== 1 || !isAddress(stored.sessionKey) || stored.validUntil <= Math.floor(Date.now() / 1000)) throw new Error('INVALID_STORED_SESSION')
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
      sessionStorage.setItem(READY_KEY, JSON.stringify({ version: 1, privateKey: session.privateKey, sessionKey: signer.address, validUntil: session.sessionValidUntil, randomness: session.randomness, accountId: browserProof.accountId, kernelAddress: created.account.address }))
      sessionStorage.removeItem(PRELOGIN_KEY); setWallet(created); setSessionExpiry(session.sessionValidUntil); await refreshBalance(created.account.address); setStage('READY')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'LOGIN_FAILED'); setStage('ERROR') }
  }, [refreshBalance])

  // OAuth redirect callback — parses id_token from URL fragment after Google redirects back.
  // Gated on stage reaching GOOGLE_READY (restore effect ran, no saved session).
  useEffect(() => {
    if (oauthHandled.current || stage !== 'GOOGLE_READY') return
    const jwt = parseIdTokenFromFragment()
    if (!jwt) return
    oauthHandled.current = true
    clearFragment()
    void completeGoogleLogin(jwt, preLogin)
  }, [stage, preLogin, completeGoogleLogin])

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
      if (elapsed < 1_500) await new Promise(r => window.setTimeout(r, 1_500 - elapsed))

      window.setTimeout(() => {
        sendDispatch({ type: 'SEND_DONE' })
        setRecipient('')
        setAmount('')
      }, 1_000)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'SEND_FAILED')
      sendDispatch({ type: 'SEND_DONE' })
    }
  }, [amount, recipient, refreshBalance, sending, wallet])

  useEffect(() => {
    if (stage !== 'PROVING') { setProofProgress(0); return }
    proofStart.current = Date.now()
    const target = estimateProofMs()
    const timer = setInterval(() => {
      const t = Math.min((Date.now() - proofStart.current) / target, 1)
      setProofProgress(0.95 * (1 - (1 - t) ** 3))
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

  if (isMobile) {
    return (
      <main className="app-shell">
        <section className="desktop-only card">
          <div className="desktop-only-icon" aria-hidden="true">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
              <line x1="8" y1="21" x2="16" y2="21"/>
              <line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
          </div>
          <h1>Desktop only</h1>
          <p>
            This wallet generates zero-knowledge proofs entirely in your browser.
            That requires significant memory and multiple CPU threads — resources
            not yet available on mobile devices.
          </p>
          <p className="desktop-only-hint">
            Open this page on a desktop or laptop to continue.
          </p>
        </section>
      </main>
    )
  }

  const canSend = !sending && !!recipient.trim() && !!amount.trim()

  return (
    <main className="app-shell">
      <nav className="topbar" aria-label="Wallet navigation">
        <span className="topbar-title">zkLogin wallet</span>
        <div className="topbar-right">
          <a className="github-badge" href="https://github.com/janek26/zklogin" target="_blank" rel="noopener noreferrer" aria-label="View source on GitHub">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
          </a>
          <span className="network-badge"><i /> {config.chain.name}</span>
          {wallet && <button className="text-button" onClick={reset}>Disconnect</button>}
        </div>
      </nav>

      <section className={`wallet-frame ${wallet ? 'is-ready' : ''}`}>
        {!wallet && (
          <Onboarding
            stage={stage}
            preLogin={preLogin}
            error={error}
            proofProgress={proofProgress}
            onReset={reset}
          />
        )}

        {wallet && (
          <WalletView
            wallet={wallet}
            balance={balance}
            recipient={recipient}
            amount={amount}
            error={error}
            userOpHash={userOpHash}
            sessionExpiry={sessionExpiry}
            countdown={countdown}
            sending={sending}
            spinning={spinning}
            canSend={canSend}
            onRecipientChange={setRecipient}
            onAmountChange={setAmount}
            onCopyAddress={() => { void copyAddress() }}
            onRefresh={() => { setSpinning(true); void refreshBalance(); window.setTimeout(() => setSpinning(false), 600) }}
            onSend={() => { void doSend() }}
          />
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
