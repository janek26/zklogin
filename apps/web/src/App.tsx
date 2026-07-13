import { GoogleLogin } from '@react-oauth/google'
import { useCallback, useEffect, useState } from 'react'
import type { Address, Hex } from 'viem'
import { getAddress, isAddress, isHex, parseAbi, parseEther, size } from 'viem'
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

  if (unsupported) return <main><h1>Unsupported browser</h1><p>This wallet requires WebAssembly, module Workers, Web Crypto, and BigInt.</p></main>
  return <main><h1>zkLogin Native Wallet</h1><p>Base Sepolia · unaudited · testnet only</p><p>Status: <strong>{stage}</strong></p>{error && <p role="alert">{error}</p>}
    {!wallet && (stage === 'GOOGLE_READY' || stage === 'ERROR') && <><GoogleLogin nonce={preLogin.googleNonce} onSuccess={(response) => { if (!response.credential) { setError('GOOGLE_RETURNED_NO_ID_TOKEN'); return } void completeGoogleLogin(response.credential, preLogin) }} onError={() => setError('GOOGLE_LOGIN_FAILED')} /><button onClick={reset}>New login session</button></>}
    {wallet && <section><p>Address: <code>{wallet.account.address}</code> <button onClick={() => void navigator.clipboard.writeText(wallet.account.address)}>Copy</button></p><p>Balance: {balance.toString()} wei</p><button onClick={() => void refreshBalance()}>Refresh balance</button><label>Recipient<input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="0x..." /></label><label>Amount (ETH)<input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" /></label><button disabled={stage !== 'READY'} onClick={() => void sendNative()}>Send native ETH</button></section>}
    {userOpHash && <p>UserOperation: <code>{userOpHash}</code></p>}<p>This UI constructs native transfers only. The active temporary key remains a full Kernel root signer until expiry.</p></main>
}
