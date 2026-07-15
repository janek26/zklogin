import { GoogleLogin } from '@react-oauth/google'
import type { Stage } from '../lib/types'
import type { PreLoginSession } from '../auth/nonce'
import { ArrowIcon } from './Icons'
import { config } from '../config'

export function statusHeadline(stage: Stage) {
  if (stage === 'PROVING') return 'Creating your private proof'
  if (stage === 'ACTIVATING') return 'Activating your wallet'
  if (stage === 'SENDING') return 'Sending your transfer'
  if (stage === 'PREPARING') return 'Preparing a secure session'
  return 'Sign in with Google'
}

function friendlyError(code: string): string {
  if (code === 'PROVING_WORKER_CRASHED') return /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'iOS ran out of memory during proof generation. Try again with fewer tabs open, or switch to desktop.' : 'Proof generation was interrupted. Try again.'
  if (code === 'PROVING_TIMEOUT') return 'Proof generation took too long. Try again on a faster device or with fewer tabs open.'
  return code.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export function Onboarding({
  stage,
  preLogin,
  error,
  proofProgress,
  onGoogleSuccess,
  onGoogleError,
  onReset,
}: {
  stage: Stage
  preLogin: PreLoginSession
  error: string | null
  proofProgress: number
  onGoogleSuccess: (credential: string) => void
  onGoogleError: () => void
  onReset: () => void
}) {
  const showProgress = stage === 'PROVING' || stage === 'ACTIVATING' || stage === 'PREPARING'
  const isIosSafari = /iPhone|iPad|iPod/.test(navigator.userAgent) && /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|OPiOS|mercury/.test(navigator.userAgent)
  const showGoogle = !showProgress && stage !== 'ERROR'

  return (
    <div className="onboarding card">
      <div className="card-meta">Local proof &middot; no custody</div>

      <div className="hero-copy">
        <h1>{statusHeadline(stage)}</h1>
        <p>
          {stage === 'PROVING' && <>Generating a zero-knowledge proof in your browser. This stays entirely local.{isIosSafari && <> Keep this tab in the foreground — iOS may reload it under memory pressure.</>}</>}
          {stage === 'ACTIVATING' && `Deploying your smart account on ${config.chain.name} and activating your session key.`}
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
            use_fedcm_for_button={true}
            ux_mode="redirect"
            theme="outline"
            shape="pill"
            size="large"
            text="continue_with"
            width="352"
            containerProps={{ className: 'google-btn-placeholder' }}
            onSuccess={(response) => {
              if (!response.credential) { onGoogleError(); return }
              onGoogleSuccess(response.credential)
            }}
            onError={onGoogleError}
          />
          <p>A single sign-in activates a 24-hour session.</p>
        </div>
      )}

      {error && (
        <div className="alert" role="alert">
          <strong>We couldn&rsquo;t continue.</strong>
          <span>{friendlyError(error)}</span>
          <button className="text-button" onClick={onReset}>Start a new session <ArrowIcon /></button>
        </div>
      )}

      <div className="trust-row">Google identity &middot; Browser proof &middot; Kernel account</div>
    </div>
  )
}
