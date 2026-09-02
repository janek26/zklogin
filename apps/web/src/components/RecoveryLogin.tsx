import { useCallback, useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import { isAddress, zeroHash } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { PassportProofResult } from './PassportProofRequest'
import { PassportProofRequest } from './PassportProofRequest'
import { createRecoveryWalletClients, entryPoint, kernelVersion, waitForSuccess } from '../aa/client'
import { toRecoveryKernelValidator } from '../aa/recoveryValidator'
import { config } from '../config'
import {
  ACTION_PROPOSE_RECOVERY,
  assertChecksummedAddress,
  bindingAsciiHex,
  createLocalRecoveryKey,
  formatRecoveryDelay,
  loadLocalRecoveryKey,
  makeFinalizeCallData,
  makeProposeCallData,
  readRecoveryState,
  recoveryBinding,
  type RecoveryAccountState,
} from '../lib/recovery'
import { formatExpiry } from '../lib/utils'

export type RecoveryLoginStage =
  | 'ADDRESS'
  | 'KEY'
  | 'PROOF'
  | 'STARTING'
  | 'WAITING'
  | 'FINALIZING'
  | 'RECOVERED'
  | 'ERROR'

/**
 * No-Google recovery flow: wallet address lookup → generate local owner →
 * passport proof → sponsored mode-0x02 proposal → wait for deadline →
 * sponsored mode-0x03 finalization → mode-0x04 owner dashboard.
 */
export function RecoveryLogin(props: { onRecovered: (kernelAddress: Address) => void }) {
  const [stage, setStage] = useState<RecoveryLoginStage>('ADDRESS')
  const [addressInput, setAddressInput] = useState('')
  const [kernelAddress, setKernelAddress] = useState<Address | null>(null)
  const [state, setState] = useState<RecoveryAccountState | null>(null)
  const [localKey, setLocalKey] = useState<{ privateKey: `0x${string}`; address: Address } | null>(null)
  const [customData, setCustomData] = useState('')
  const [userOpHash, setUserOpHash] = useState<`0x${string}` | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [executableAt, setExecutableAt] = useState(0)
  const [countdown, setCountdown] = useState('')
  const finalizeRef = useRef(false)

  const lookUp = useCallback(async () => {
    try {
      const address = assertChecksummedAddress(addressInput.trim())
      const s = await readRecoveryState(address)
      if (s.guardianNullifier === zeroHash && !s.recovery.proposedOwner) {
        throw new Error('This wallet has no passport recovery')
      }
      setKernelAddress(address)
      setState(s)
      setStage('KEY')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'LOOKUP_FAILED')
      setStage('ERROR')
    }
  }, [addressInput])

  const generateKey = useCallback(() => {
    if (!kernelAddress || !state) return
    const nextNonce = state.recoveryNonce + 1n
    const key = loadLocalRecoveryKey({ chainId: config.chainId, kernelAddress, recoveryNonce: nextNonce })
    const owner = key ?? createLocalRecoveryKey({ chainId: config.chainId, kernelAddress, recoveryNonce: nextNonce })
    setLocalKey(owner)
    // Canonical PROPOSE_RECOVERY binding for the next recovery nonce.
    const binding = recoveryBinding({
      chainId: config.chainId,
      kernel: kernelAddress,
      action: ACTION_PROPOSE_RECOVERY,
      proposedOwner: owner.address,
      guardianNonce: state.guardianNonce,
      recoveryNonce: nextNonce,
    })
    setCustomData(bindingAsciiHex(binding))
    setStage('PROOF')
  }, [kernelAddress, state])

  const startProposal = useCallback(async (result: PassportProofResult) => {
    if (!kernelAddress || !state || !localKey) return
    const recoveryNonce = state.recoveryNonce + 1n
    setStage('STARTING')
    setError(null)
    try {
      const auth = { params: result.params, proposedOwner: localKey.address, recoveryNonce }
      // The proposal auth is the passport proof (mode 0x02), but the adapter
      // still signs the userOp hash with the local key — give it a real
      // signer so signUserOperation does not fail on a bare {address} stub.
      const validator = await toRecoveryKernelValidator({
        entryPoint,
        kernelVersion,
        chainId: config.chainId,
        validatorAddress: config.validatorAddress,
        signer: privateKeyToAccount(localKey.privateKey),
        kind: 'proposal',
        accountId: state.accountId,
        proposalAuth: auth,
      })
      const callData = makeProposeCallData({
        validatorAddress: config.validatorAddress,
        params: result.params,
        proposedOwner: localKey.address,
        recoveryNonce,
      })
      const clients = await createRecoveryWalletClients(validator, kernelAddress)
      const hash = await clients.kernelClient.sendUserOperation({ callData })
      setUserOpHash(hash)
      await waitForSuccess(clients.kernelClient, hash)
      const fresh = await readRecoveryState(kernelAddress)
      setState(fresh)
      setExecutableAt(fresh.recovery.executableAt)
      setStage('WAITING')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'PROPOSAL_FAILED')
      setStage('ERROR')
    }
  }, [kernelAddress, state, localKey])

  const finalize = useCallback(async () => {
    if (!kernelAddress || !state || !localKey || finalizeRef.current) return
    finalizeRef.current = true
    setStage('FINALIZING')
    setError(null)
    try {
      const signer = privateKeyToAccount(localKey.privateKey)
      const validator = await toRecoveryKernelValidator({
        entryPoint,
        kernelVersion,
        chainId: config.chainId,
        validatorAddress: config.validatorAddress,
        signer,
        kind: 'finalize',
        accountId: state.accountId,
        recoveryNonce: state.recovery.nonce,
      })
      const callData = makeFinalizeCallData({
        validatorAddress: config.validatorAddress,
        recoveryNonce: state.recovery.nonce,
      })
      const clients = await createRecoveryWalletClients(validator, kernelAddress)
      const hash = await clients.kernelClient.sendUserOperation({ callData })
      setUserOpHash(hash)
      await waitForSuccess(clients.kernelClient, hash)
      setStage('RECOVERED')
    } catch (cause) {
      finalizeRef.current = false
      setError(cause instanceof Error ? cause.message : 'FINALIZE_FAILED')
      setStage('WAITING')
    }
  }, [kernelAddress, state, localKey, props])

  // 1-second countdown from the last confirmed executableAt; never enables
  // finalization on countdown alone.
  useEffect(() => {
    if (stage !== 'WAITING' || !executableAt) return
    const tick = () => {
      const rem = executableAt - Math.floor(Date.now() / 1000)
      if (rem <= 0) { setCountdown('Ready to complete'); return }
      const h = Math.floor(rem / 3600)
      const m = Math.floor((rem % 3600) / 60)
      const s = rem % 60
      setCountdown(h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`)
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [stage, executableAt])

  const canFinalize = stage === 'WAITING' && !!executableAt && Math.floor(Date.now() / 1000) >= executableAt

  return (
    <div className="recovery-login card">
      <div className="card-meta">Passport recovery · no Google sign-in</div>

      {stage === 'ADDRESS' && (
        <>
          <h1>Recover a wallet</h1>
          <p>Enter the wallet address you need to recover. It must already have passport recovery enabled.</p>
          <div className="field">
            <label htmlFor="recovery-address">Wallet address</label>
            <input
              id="recovery-address"
              value={addressInput}
              onChange={(event) => setAddressInput(event.target.value)}
              placeholder="0x1234…"
              autoComplete="off"
              spellCheck="false"
            />
          </div>
          <button className="primary-button" disabled={!isAddress(addressInput.trim())} onClick={() => void lookUp()}>
            Continue
          </button>
        </>
      )}

      {stage === 'KEY' && kernelAddress && (
        <>
          <h1>Generate a local owner</h1>
          <p>
            Recovery uses a temporary key generated in this browser and stored only in this
            browser's local storage. It is never shown or exported.
          </p>
          <button className="primary-button" onClick={generateKey}>
            Generate local owner
          </button>
        </>
      )}

      {stage === 'PROOF' && kernelAddress && localKey && state && (
        <>
          <h1>Prove your passport</h1>
          <p>
            Your passport proves you may propose <code>{localKey.address}</code> as the new owner.
            {state.recoveryDelay === 0
              ? 'Recovery happens immediately.'
              : `Recovery waits ${formatRecoveryDelay(state.recoveryDelay)}.`}
          </p>
          <PassportProofRequest
            action="PROPOSE_RECOVERY"
            walletAddress={kernelAddress}
            customData={customData}
            onResult={(result) => { void startProposal(result) }}
            onError={(err) => { setError(err); setStage('ERROR') }}
          />
        </>
      )}

      {(stage === 'STARTING' || stage === 'FINALIZING') && (
        <div className="progress-panel" aria-live="polite">
          <strong>{stage === 'STARTING' ? 'Starting recovery' : 'Completing recovery'}</strong>
          <span>Submitting sponsored transaction…</span>
          {userOpHash && (
            <a
              className="tx-link"
              href={`${config.chain.blockExplorers.default.url}/tx/${userOpHash}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View on explorer ↗
            </a>
          )}
        </div>
      )}

      {stage === 'WAITING' && (
        <>
          <h1>Recovery scheduled</h1>
          <p>
            The new owner can take over after <strong>{formatExpiry(executableAt)}</strong>.
          </p>
          <p className="recovery-countdown">{countdown}</p>
          <button className="primary-button" disabled={!canFinalize} onClick={() => void finalize()}>
            Complete recovery
          </button>
          <p className="recovery-details">
            Before the deadline no completion action exists. A countdown reaching zero never
            enables finalization until a fresh on-chain read confirms the proposal.
          </p>
        </>
      )}

      {stage === 'RECOVERED' && kernelAddress && (
        <div className="recovery-done" role="status">
          <h1>Recovery complete</h1>
          <p>You now control the wallet from this browser. Move funds to a safer wallet with Send.</p>
          {userOpHash && (
            <a
              className="tx-link"
              href={`${config.chain.blockExplorers.default.url}/tx/${userOpHash}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View finalize transaction on explorer ↗
            </a>
          )}
          <button
            className="primary-button recovery-open-wallet"
            onClick={() => props.onRecovered(kernelAddress)}
          >
            Open wallet
          </button>
        </div>
      )}

      {stage === 'ERROR' && (
        <div className="alert" role="alert">
          <strong>Recovery needs attention</strong>
          <span>{error}</span>
          <button className="text-button" onClick={() => setStage('ADDRESS')}>Start over</button>
        </div>
      )}
    </div>
  )
}

