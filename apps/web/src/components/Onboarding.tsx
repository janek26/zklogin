import type { Stage } from '../lib/types'
import type { PreLoginSession } from '../auth/nonce'
import { ArrowIcon } from './Icons'
import { config } from '../config'
import { buildOAuthUrl } from '../auth/googleOAuth'
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
  onReset,
}: {
  stage: Stage
  preLogin: PreLoginSession
  error: string | null
  proofProgress: number
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
          <button
            type="button"
            className="google-signin-btn"
            onClick={() => {
              const url = buildOAuthUrl({
                clientId: config.googleClientId,
                redirectUri: config.redirectOrigin,
                nonce: preLogin.googleNonce,
              })
              window.location.assign(url)
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" style={{ marginRight: 12, flexShrink: 0 }}>
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>
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
