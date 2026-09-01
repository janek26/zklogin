import { useState } from 'react'
import { zeroAddress } from 'viem'
import type { PassportProofAction, PassportProofResult } from './PassportProofRequest'
import { PassportProofRequest } from './PassportProofRequest'
import { RECOVERY_DELAYS, DEFAULT_RECOVERY_DELAY_SECONDS, type RecoveryAccountState } from '../lib/recovery'

/**
 * Guardian setup / rotation card. Two steps: choose delay, then scan passport.
 * The submitted proof goes through the normal sponsored session UserOperation
 * to `setGuardian`; the contract accepts only the exact allowed delay values.
 */
export function RecoverySetup(props: {
  walletAddress: `0x${string}`
  state: RecoveryAccountState
  rotating: boolean
  submitting: boolean
  customData: string
  onProofResult: (result: PassportProofResult) => void
  onProofError: (error: string) => void
  onCancelSetup: () => void
}) {
  const [delaySeconds, setDelaySeconds] = useState<number>(
    props.rotating && props.state.recoveryDelay > 0
      ? props.state.recoveryDelay
      : DEFAULT_RECOVERY_DELAY_SECONDS,
  )
  const [confirmed, setConfirmed] = useState(false)

  const immediate = delaySeconds === 0
  const action: PassportProofAction = 'SET_GUARDIAN'

  return (
    <section className="recovery-setup card">
      <div className="card-header">
        <div>
          <p className="eyebrow">{props.rotating ? 'Replace passport guardian' : 'Add passport recovery'}</p>
          <h2>Passport guardian</h2>
        </div>
        <button className="text-button" onClick={props.onCancelSetup} disabled={props.submitting}>
          Close
        </button>
      </div>

      <p className="setup-disclosure">
        Your passport app creates a zero-knowledge proof. This wallet does not receive or store
        your name, passport number, document image, face image, nationality, or date of birth.
        On chain, it stores a pseudonymous passport identifier. Because this identifier uses
        the same recovery policy for every wallet, observers can link wallets that use the same
        passport recovery identity.
      </p>

      <div className="delay-chooser" role="radiogroup" aria-label="Choose recovery time">
        {RECOVERY_DELAYS.map((delay) => (
          <button
            key={delay.seconds}
            className={`delay-card${delaySeconds === delay.seconds ? ' selected' : ''}`}
            onClick={() => setDelaySeconds(delay.seconds)}
            disabled={props.submitting}
            role="radio"
            aria-checked={delaySeconds === delay.seconds}
          >
            <strong>{delay.label}</strong>
          </button>
        ))}
      </div>

      {immediate && (
        <div className="alert compact" role="alert">
          <strong>Immediate recovery warning</strong>
          <span>
            Immediate recovery has no reliable cancellation window. Anyone able to use your
            enrolled passport can immediately replace the owner.
          </span>
          <label className="confirm-check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              disabled={props.submitting}
            />
            I understand recovery will be instant.
          </label>
        </div>
      )}

      <div className="qr-card">
        <p>Scan your passport to prove recovery eligibility. No passport details are added to this
          wallet — the proof stays zero-knowledge.</p>
        <PassportProofRequest
          action={action}
          walletAddress={props.walletAddress}
          customData={props.customData}
          onResult={props.onProofResult}
          onError={props.onProofError}
        />
        {props.submitting && <p className="recovery-details">Submitting guardian update…</p>}
      </div>

      <p className="recovery-details">
        Recovery waits{' '}
        <strong>
          {delaySeconds === 0 ? 'Immediate' : `${delaySeconds / 86400} day${delaySeconds / 86400 === 1 ? '' : 's'}`}
        </strong>
        {immediate && !confirmed ? ' — confirm the warning first' : ''}
      </p>
    </section>
  )
}
