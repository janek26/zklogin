/// <reference lib="webworker" />
import { zklogin } from '@shield-labs/zklogin'
import snapshot from '../generated/jwk-snapshot.json'

type Request = { jwt: string; expectedNonce: string }
export type BrowserProof = { proof: `0x${string}`; accountId: `0x${string}`; jwtIat: number; publicKeyHash: `0x${string}`; jwkProof: `0x${string}`[] }
type FrozenKey = Awaited<ReturnType<zklogin.PublicKeyRegistry['getPublicKeyByKid']>>
class FrozenPublicKeyRegistry extends zklogin.PublicKeyRegistry {
  override async getPublicKeyByKid(kid: string): Promise<FrozenKey> {
    const key = snapshot.keys.find((candidate: { kid: string }) => candidate.kid === kid)
    if (!key) throw new Error('JWK_SNAPSHOT_MISS')
    return key as FrozenKey
  }
}
const context = self as unknown as DedicatedWorkerGlobalScope
context.onmessage = async (event: MessageEvent<Request>) => {
  try {
    const result = await new zklogin.ZkLogin(new FrozenPublicKeyRegistry()).proveJwt(event.data.jwt, event.data.expectedNonce)
    if (!result) throw new Error('JWT_OR_NONCE_REJECTED')
    const key = (snapshot.keys as Array<{ hash: string; jwkProof: `0x${string}`[] }>).find((candidate) => candidate.hash.toLowerCase() === result.input.public_key_hash.toLowerCase())
    if (!key) throw new Error('JWK_SNAPSHOT_MISS')
    context.postMessage({ ok: true, response: { proof: result.proof, accountId: result.input.account_id, jwtIat: result.input.jwt_iat, publicKeyHash: result.input.public_key_hash, jwkProof: key.jwkProof } satisfies BrowserProof })
  } catch (error) {
    context.postMessage({ ok: false, error: error instanceof Error ? error.message : 'PROVING_FAILED' })
  }
}
