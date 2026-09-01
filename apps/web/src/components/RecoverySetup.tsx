import { useState } from 'react'
import type { PassportProofAction, PassportProofResult } from './PassportProofRequest'
import { PassportProofRequest } from './PassportProofRequest'
import { RECOVERY_DELAYS, DEFAULT_RECOVERY_DELAY_SECONDS, formatRecoveryDelay, type RecoveryAccountState } from '../lib/recovery'

type Step = 1 | 2 | 3

const DELAY_HELP: Record<number, string> = {
  0: 'A passport can take over as soon as the request lands. There is no cancellation window.',
  86400: 'The new owner can take over one day after the request. You can cancel in between.',
  259200: 'The new owner can take over three days after the request. You can cancel in between.',
  604800: 'The new owner can take over one week after the request. You can cancel in between.',
  2592000: 'The new owner can take over 30 days after the request. You can cancel in between.',
}

/**
 * Guardian setup / rotation wizard. Three steps: choose recovery time →
 * review and confirm → scan passport. The proof result flows to the parent,
 * which submits the sponsored `setGuardian` UserOperation.
 */
export function RecoverySetup(props: {
  walletAddress: `0x${string}`
  state: RecoveryAccountState
  rotating: boolean
  submitting: boolean
  customData: string
  /** Submission/scan failure message from the parent, shown in step 3. */
  error?: string | null
  onProofResult: (result: PassportProofResult) => void
  onProofError: (error: string) => void
  onCancelSetup: () => void
}) {
  const [step, setStep] = useState<Step>(1)
  const [delaySeconds, setDelaySeconds] = useState<number>(
    props.rotating && props.state.recoveryDelay > 0
      ? props.state.recoveryDelay
      : DEFAULT_RECOVERY_DELAY_SECONDS,
  )
  const [confirmed, setConfirmed] = useState(false)

  const immediate = delaySeconds === 0
  const action: PassportProofAction = 'SET_GUARDIAN'
  const stepTitles = ['Recovery time', 'Review', 'Scan passport']

  return (
    <section className="recovery-setup card">
      <div className="card-header">
        <div>
          <p className="eyebrow">
            {props.rotating ? 'Replace passport guardian' : 'Add passport recovery'}
          </p>
          <h2>Passport guardian</h2>
        </div>
        <button className="text-button" onClick={props.onCancelSetup} disabled={props.submitting}>
          Close
        </button>
      </div>

      <ol className="setup-steps" aria-label="Setup steps">
        {stepTitles.map((title, index) => {
          const n = (index + 1) as Step
          return (
            <li key={n} className={n === step ? 'current' : n < step ? 'done' : ''}>
              <span className="setup-step-dot">{n < step ? '✓' : n}</span>
              <span className="setup-step-label">{title}</span>
            </li>
          )
        })}
      </ol>

      {step === 1 && (
        <div className="setup-step-body">
          <h3>How long should recovery wait?</h3>
          <p className="setup-step-lead">
            If Google access ever stops working, your passport can propose a new owner. You
            choose how long the wallet waits before that owner takes over.
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
                <span className="delay-card-help">{DELAY_HELP[delay.seconds]}</span>
              </button>
            ))}
          </div>
          <div className="setup-actions">
            <button
              className="primary-button"
              onClick={() => { setConfirmed(false); setStep(2) }}
              disabled={props.submitting}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="setup-step-body">
          <h3>Review your choice</h3>
          <div className="setup-summary">
            <div className="setup-summary-row">
              <span>{immediate ? 'Recovery timing' : 'Recovery waits'}</span>
              <strong>{formatRecoveryDelay(delaySeconds)}</strong>
            </div>
            <div className="setup-summary-row">
              <span>Guardian</span>
              <strong>Your passport</strong>
            </div>
            <div className="setup-summary-row">
              <span>Proof</span>
              <strong>Zero-knowledge, no passport data stored</strong>
            </div>
          </div>

          <p className="setup-disclosure">
            Your passport app creates a zero-knowledge proof. This wallet does not receive or
            store your name, passport number, document image, face image, nationality, or date
            of birth. On chain it stores a pseudonymous passport identifier. Because the
            identifier uses the same recovery policy for every wallet, observers can link
            wallets that use the same passport recovery identity.
          </p>

          {immediate && (
            <div className="immediate-confirm" role="alert">
              <strong>Immediate recovery has no cancellation window</strong>
              <p>
                Anyone able to use your enrolled passport can immediately replace the owner.
                There is no dependable window to cancel.
              </p>
              <label className="confirm-check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  disabled={props.submitting}
                />
                <span>I understand recovery will be instant.</span>
              </label>
            </div>
          )}

          <div className="setup-actions">
            <button className="text-button" onClick={() => setStep(1)} disabled={props.submitting}>
              Back
            </button>
            <button
              className="primary-button"
              onClick={() => setStep(3)}
              disabled={props.submitting || (immediate && !confirmed)}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="setup-step-body">
          <h3>Scan your passport</h3>
          <p className="setup-step-lead">
            Open the ZKPassport app and scan the QR code to prove recovery eligibility.
            {immediate ? ' Recovery happens immediately after you confirm on your phone.' : ` The new owner can take over after ${formatRecoveryDelay(delaySeconds).toLowerCase()}.`}
          </p>
          <div className="qr-card">
            <PassportProofRequest
              action={action}
              walletAddress={props.walletAddress}
              customData={props.customData}
              onResult={props.onProofResult}
              onError={props.onProofError}
            />
            {props.submitting && (
              <p className="recovery-details">Submitting guardian update…</p>
            )}
            {props.error && (
              <p className="recovery-error" role="alert">
                {props.error}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
