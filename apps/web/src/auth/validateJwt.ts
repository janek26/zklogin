import { decodeJwt, decodeProtectedHeader } from 'jose'
import { config } from '../config'

export function validateGoogleCredential(jwt: string, expectedNonce: string) {
  const header = decodeProtectedHeader(jwt)
  const payload = decodeJwt(jwt)
  const now = Math.floor(Date.now() / 1000)
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('BAD_JWT_HEADER')
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') throw new Error('BAD_ISSUER')
  if (payload.aud !== config.googleClientId) throw new Error('BAD_AUDIENCE')
  if (typeof payload.sub !== 'string' || typeof payload.iat !== 'number' || typeof payload.exp !== 'number') throw new Error('BAD_JWT_CLAIMS')
  if (payload.nonce !== expectedNonce) throw new Error('BAD_NONCE')
  if (payload.iat > now + 300 || payload.iat < now - 300) throw new Error('STALE_IAT')
  if (payload.exp <= now) throw new Error('EXPIRED_JWT')
  return payload
}
