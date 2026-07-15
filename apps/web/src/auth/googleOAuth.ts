/**
 * Pure OAuth 2.0 Implicit Flow with redirect.
 * No cross-origin script loads — works with COEP: require-corp in all browsers.
 *
 * Flow:
 *  1. buildOAuthUrl() — construct Google OAuth URL with nonce
 *  2. window.location.assign(url) — full-page redirect to Google
 *  3. Google redirects back with id_token in URL fragment
 *  4. parseIdTokenFromFragment() — extract JWT from #id_token=...
 *  5. clearFragment() — remove the fragment from the URL
 */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'

export function buildOAuthUrl(params: {
  clientId: string
  redirectUri: string
  nonce: string
}): string {
  const url = new URL(GOOGLE_AUTH_URL)
  url.searchParams.set('response_type', 'id_token')
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('nonce', params.nonce)
  url.searchParams.set('scope', 'openid email profile')
  return url.toString()
}

/** Extracts the id_token from the URL fragment after Google redirect. */
export function parseIdTokenFromFragment(): string | null {
  const fragment = window.location.hash
  if (!fragment) return null
  const params = new URLSearchParams(fragment.slice(1))
  return params.get('id_token')
}

/** Removes the OAuth fragment from the URL without reloading the page. */
export function clearFragment(): void {
  if (!window.location.hash) return
  const url = new URL(window.location.href)
  url.hash = ''
  history.replaceState(null, '', url.toString())
}
