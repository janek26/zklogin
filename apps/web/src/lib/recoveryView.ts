import { useCallback, useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import { zeroAddress } from 'viem'
import type { Wallet } from './types'
import { publicClient, waitForSuccess } from '../aa/client'
import { config } from '../config'
import type { PassportProofResult } from '../components/PassportProofRequest'
import { checkCertificateRoot } from './passportPreflight'
import { extractRevertReason } from './utils'
import {
  ACTION_SET_GUARDIAN,
  bindingAsciiHex,
  deleteLocalRecoveryKey,
  makeCancelInnerData,
  makeClearGuardianInnerData,
  makeSetGuardianInnerData,
  readRecoveryState,
  recoveryBinding,
  type RecoveryAccountState,
} from './recovery'

export type RecoveryViewModel = {
  state: RecoveryAccountState | null
  error: string | null
  submitting: boolean
  /** One-second countdown from the last confirmed executableAt. */
  countdown: string
  refresh: () => Promise<void>
  submitSetGuardian: (result: PassportProofResult) => Promise<void>
  submitCancel: (alsoRemoveGuardian: boolean) => Promise<void>
  forgetLocalKey: () => Promise<void>
}

const POLL_NO_PROPOSAL_MS = 60_000
// L1 Sepolia confirms at ~12s/block. A 30s poll catches a proposal becoming
// executable within a couple of blocks without hammering the RPC.
const POLL_ACTIVE_MS = 30_000

/**
 * Dashboard recovery integration: reads public recovery state, polls on the
 * plan's schedule (60s idle / 15s active proposal), pauses while the tab is
 * hidden, and submits sponsored UserOperations for guardian setup, cancellation,
 * and removal. Chain reads are authoritative; the countdown is presentation.
 */
export function useRecovery(args: { wallet: Wallet | null; kernelAddress: Address | null; enabled: boolean }): RecoveryViewModel {
  const [state, setState] = useState<RecoveryAccountState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [countdown, setCountdown] = useState('')
  const [executableAt, setExecutableAt] = useState(0)
  const submittingRef = useRef(false)

  const refresh = useCallback(async () => {
    if (!args.kernelAddress) return
    try {
      const s = await readRecoveryState(args.kernelAddress)
      setState(s)
      setExecutableAt(s.recovery.executableAt)
      setError(null)
    } catch {
      // Polling is best-effort; keep the last known state.
    }
  }, [args.kernelAddress])

  // Read on enable (login/restore) and poll on the schedule; pause when hidden.
  useEffect(() => {
    if (!args.enabled || !args.kernelAddress) return
    void refresh()
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      // The 15s active-proposal schedule below supersedes the idle poll.
      if (state?.recovery.proposedOwner && state.recovery.proposedOwner !== zeroAddress) return
      void refresh()
    }, POLL_NO_PROPOSAL_MS)
    const visibleRefresh = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', visibleRefresh)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', visibleRefresh)
    }
  }, [args.enabled, args.kernelAddress, refresh, state?.recovery.proposedOwner])

  // 15s schedule once a proposal exists.
  useEffect(() => {
    if (!state?.recovery.proposedOwner || state.recovery.proposedOwner === zeroAddress) return
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void refresh()
    }, POLL_ACTIVE_MS)
    return () => clearInterval(interval)
  }, [state?.recovery.proposedOwner, refresh])

  // One-second countdown from the last confirmed executableAt.
  useEffect(() => {
    if (!state?.recovery.proposedOwner || state.recovery.proposedOwner === zeroAddress || !executableAt) return
    const tick = () => {
      const rem = executableAt - Math.floor(Date.now() / 1000)
      if (rem <= 0) { setCountdown('Deadline reached'); return }
      const h = Math.floor(rem / 3600)
      const m = Math.floor((rem % 3600) / 60)
      const s = rem % 60
      setCountdown(h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`)
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [state?.recovery.proposedOwner, executableAt])

  const runOp = useCallback(async (send: () => Promise<`0x${string}`>) => {
    if (!args.wallet || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      console.log('[recovery] sending sponsored UserOperation…')
      const hash = await send()
      console.log('[recovery] UserOperation sent', hash)
      await waitForSuccess(args.wallet.kernelClient, hash)
      console.log('[recovery] UserOperation confirmed', hash)
      await refresh()
    } catch (cause) {
      console.error('[recovery] UserOperation failed', cause)
      throw cause
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }, [args.wallet, refresh])

  const submitSetGuardian = useCallback(async (result: PassportProofResult) => {
    if (!args.kernelAddress || !state) return
    try {
      // Catch the common stale-certificate-root failure before the paymaster
      // simulation buries it in a nested RPC error.
      const staleRoot = await checkCertificateRoot(result.params, {
        reader: publicClient,
        registryAddress: config.zkPassportRootRegistry as Address,
      })
      if (staleRoot) {
        console.warn('[recovery] certificate registry preflight failed', staleRoot)
        setError(staleRoot)
        throw new Error(staleRoot)
      }
      console.log('[recovery] submitting setGuardian', {
        kernel: args.kernelAddress,
        delaySeconds: state.recoveryDelay,
      })
      await runOp(() => args.wallet!.kernelClient.sendUserOperation({
        calls: [{
          to: config.validatorAddress,
          value: 0n,
          data: makeSetGuardianInnerData({ params: result.params, delaySeconds: state.recoveryDelay }),
        }],
      }))
    } catch (cause) {
      const reason = extractRevertReason(cause)
      console.error('[recovery] setGuardian failed', { reason, error: cause })
      setError(reason ?? (cause instanceof Error ? cause.message : 'SET_GUARDIAN_FAILED'))
      throw cause
    }
  }, [args.kernelAddress, state, args.wallet, runOp])

  const submitCancel = useCallback(async (alsoRemoveGuardian: boolean) => {
    try {
      const calls = alsoRemoveGuardian
        ? [{ to: config.validatorAddress, value: 0n, data: makeCancelInnerData() }, { to: config.validatorAddress, value: 0n, data: makeClearGuardianInnerData() }]
        : [{ to: config.validatorAddress, value: 0n, data: makeCancelInnerData() }]
      await runOp(() => args.wallet!.kernelClient.sendUserOperation({ calls: calls as never }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'CANCEL_FAILED')
      throw cause
    }
  }, [args.wallet, runOp])

  const forgetLocalKey = useCallback(async () => {
    if (!args.kernelAddress || !state?.recovery) return
    const confirmed = window.confirm(
      'This permanently deletes the browser-only recovery key for this wallet. ' +
      'The wallet must already be empty — otherwise its funds become unrecoverable. Continue?',
    )
    if (!confirmed) return
    deleteLocalRecoveryKey({
      chainId: config.chainId,
      kernelAddress: args.kernelAddress,
      recoveryNonce: state.recovery.nonce,
    })
    await refresh()
  }, [args.kernelAddress, state, refresh])

  return { state, error, submitting, countdown, refresh, submitSetGuardian, submitCancel, forgetLocalKey }
}

/** Builds the canonical SET_GUARDIAN custom_data binding for the QR proof. */
export function setGuardianCustomData(args: { chainId: number; kernelAddress: Address; state: RecoveryAccountState }): string {
  return bindingAsciiHex(recoveryBinding({
    chainId: args.chainId,
    kernel: args.kernelAddress,
    action: ACTION_SET_GUARDIAN,
    proposedOwner: zeroAddress,
    guardianNonce: args.state.guardianNonce + 1n,
    recoveryNonce: args.state.recoveryNonce,
  }))
}
