import { GoogleLogin } from '@react-oauth/google'
import type { Stage } from '../lib/types'
import type { PreLoginSession } from '../auth/nonce'
import { ArrowIcon } from './Icons'

export function statusHeadline(stage: Stage) {
  if (stage === 'PROVING') return 'Creating your private proof'
  if (stage === 'ACTIVATING') return 'Activating your wallet'
  if (stage === 'SENDING') return 'Sending your transfer'
  if (stage === 'PREPARING') return 'Preparing a secure session'
  return 'Sign in with Google'
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
  const showGoogle = !showProgress && stage !== 'ERROR'

  return (
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
          <span>{error}</span>
          <button className="text-button" onClick={onReset}>Start a new session <ArrowIcon /></button>
        </div>
      )}

      <div className="trust-row">Google identity &middot; Browser proof &middot; Kernel account</div>
    </div>
  )
}
