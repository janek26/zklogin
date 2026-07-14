import { GoogleLogin } from '@react-oauth/google'
import { useCallback, useEffect, useState } from 'react'
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
const PRELOGIN_KEY = 'zklogin.prelogin.v1'
const READY_KEY = 'zklogin.ready.v1'
const validatorStateAbi = parseAbi(['function accountState(address kernel) view returns (bytes32 accountId,address sessionKey,uint48 sessionValidUntil)'])

function shortAddress(address: string) { return `${address.slice(0, 6)}…${address.slice(-4)}` }
function statusCopy(stage: Stage) {
  if (stage === 'PROVING') return ['Creating your private proof', 'This stays in your browser. It can take a moment.']
  if (stage === 'ACTIVATING') return ['Activating your wallet', 'Deploying your Kernel account and approving this session key.']
  if (stage === 'SENDING') return ['Sending your transfer', 'Waiting for Base Sepolia to confirm your UserOperation.']
  if (stage === 'PREPARING') return ['Preparing a secure session', 'Generating a short-lived key and nonce locally.']
  return ['Sign in once to get started', 'Google verifies your identity. Your proof is generated locally.']
}

function Mark() { return <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span> }
function CopyIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg> }
function ArrowIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13" /><path d="m13 6 6 6-6 6" /></svg> }
function RefreshIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0 2 5.5" /><path d="M20 4v7h-7" /></svg> }

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

export function App() {
  const [stage, setStage] = useState<Stage>('PREPARING')
  const [preLogin, setPreLogin] = useState<PreLoginSession>(loadOrCreatePreLogin)
  const [wallet, setWallet] = useState<Wallet | null>(null)
  const [balance, setBalance] = useState<bigint>(0n)
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [userOpHash, setUserOpHash] = useState<Hex | null>(null)
  const [copied, setCopied] = useState(false)
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
        if (!cancelled) { setWallet(restored); await refreshBalance(restored.account.address); setStage('READY') }
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
      sessionStorage.removeItem(PRELOGIN_KEY); setWallet(created); await refreshBalance(created.account.address); setStage('READY')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'LOGIN_FAILED'); setStage('ERROR') }
  }, [refreshBalance])
  const sendNative = useCallback(async () => {
    if (!wallet || stage !== 'READY') throw new Error('WALLET_NOT_READY')
    const target = getAddress(recipient.trim()); const value = parseEther(amount.trim())
    if (value <= 0n) throw new Error('AMOUNT_MUST_BE_POSITIVE')
    const current = await publicClient.getBalance({ address: wallet.account.address }); if (value > current) throw new Error('INSUFFICIENT_NATIVE_BALANCE')
    setStage('SENDING'); setError(null)
    try { const hash = await wallet.kernelClient.sendUserOperation({ calls: [{ to: target, value, data: '0x' }] }); setUserOpHash(hash); await waitForSuccess(wallet.kernelClient, hash); await refreshBalance() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'SEND_FAILED') }
    finally { setStage('READY') }
  }, [amount, recipient, refreshBalance, stage, wallet])

  const copyAddress = useCallback(async () => {
    if (!wallet) return
    await navigator.clipboard.writeText(wallet.account.address)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_800)
  }, [wallet])

  const [headline, description] = statusCopy(stage)
  const sessionExpiry = wallet ? new Date(Number((sessionStorage.getItem(READY_KEY) ? JSON.parse(sessionStorage.getItem(READY_KEY)!).validUntil : 0) * 1_000)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null

  if (unsupported) return <main className="app-shell"><section className="unsupported card"><Mark /><p className="eyebrow">Unsupported browser</p><h1>One capability is missing.</h1><p>This wallet needs WebAssembly, module Workers, Web Crypto, and BigInt to create a proof safely in your browser.</p></section></main>
  return <main className="app-shell">
    <nav className="topbar" aria-label="Wallet navigation"><a className="wordmark" href="/"><Mark /><span>Glyph</span></a><div className="network-badge"><i /> Base Sepolia</div></nav>
    <section className={`wallet-frame ${wallet ? 'is-ready' : ''}`}>
      {!wallet && <div className="onboarding card">
        <div className="card-header"><span className="step-pill">01 <span>of 01</span></span><span className="security-note">Local proof · no custody</span></div>
        <div className="hero-copy"><p className="eyebrow">Your personal testnet wallet</p><h1>{headline}</h1><p>{description}</p></div>
        {(stage === 'PROVING' || stage === 'ACTIVATING' || stage === 'PREPARING') ? <div className="progress-panel" aria-live="polite"><span className="spinner" /><div><strong>{stage === 'PROVING' ? 'Proving with Google' : stage === 'ACTIVATING' ? 'Submitting activation' : 'Generating session'}</strong><span>Keep this tab open</span></div></div> : <div className="google-slot"><GoogleLogin nonce={preLogin.googleNonce} theme="outline" shape="pill" size="large" text="continue_with" width="352" onSuccess={(response) => { if (!response.credential) { setError('GOOGLE_RETURNED_NO_ID_TOKEN'); return } void completeGoogleLogin(response.credential, preLogin) }} onError={() => setError('GOOGLE_LOGIN_FAILED')} /><p>One sign-in activates a 24-hour session.</p></div>}
        {error && <div className="alert" role="alert"><strong>We couldn’t continue.</strong><span>{error}</span><button className="text-button" onClick={reset}>Start a new session <ArrowIcon /></button></div>}
        <div className="trust-row"><span>Google identity</span><span>Browser proof</span><span>ZeroDev Kernel</span></div>
      </div>}

      {wallet && <div className="wallet-grid">
        <section className="balance-card card"><div className="card-header"><div><p className="eyebrow">Available balance</p><button className="address-button" onClick={() => void copyAddress()} title="Copy wallet address"><span>{shortAddress(wallet.account.address)}</span><CopyIcon /></button></div><button className="icon-button" onClick={() => void refreshBalance()} title="Refresh balance"><RefreshIcon /></button></div><div className="balance-value">{Number(formatEther(balance)).toLocaleString(undefined, { maximumFractionDigits: 5 })}<span> ETH</span></div><div className="balance-meta"><span><i /> Ready to send</span><span>Session ends {sessionExpiry}</span></div></section>
        <section className="send-card card"><div className="card-header"><div><p className="eyebrow">Send</p><h2>Native ETH</h2></div><span className="asset-token">ETH</span></div><div className="field"><label htmlFor="recipient">Recipient</label><input id="recipient" value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="0x1234…" autoComplete="off" spellCheck="false" /></div><div className="field amount-field"><label htmlFor="amount">Amount</label><div className="amount-input"><input id="amount" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" inputMode="decimal" /><span>ETH</span></div></div><button className="primary-button" disabled={stage !== 'READY' || !recipient || !amount} onClick={() => void sendNative()}>{stage === 'SENDING' ? <><span className="button-spinner" /> Sending</> : <>Review & send <ArrowIcon /></>}</button>{error && <div className="alert compact" role="alert"><strong>Transfer needs attention</strong><span>{error}</span></div>}</section>
        <aside className="session-card"><div className="session-icon"><Mark /></div><div><p className="eyebrow">Secure session</p><strong>Active until {sessionExpiry}</strong><p>Only this tab holds your temporary key. Closing it requires one new Google sign-in.</p></div></aside>
      </div>}
      {userOpHash && <div className="receipt" role="status"><span className="receipt-dot" /> {stage === 'SENDING' || stage === 'ACTIVATING' ? 'UserOperation pending' : 'Latest UserOperation confirmed'} <code>{shortAddress(userOpHash)}</code></div>}
      {copied && <div className="toast" role="status">Wallet address copied</div>}
    </section>
    <footer><span>Unaudited research POC</span><span>Native transfers only in this interface</span></footer>
  </main>
}
