import { writeFile } from 'node:fs/promises'
import { StandardMerkleTree } from '@openzeppelin/merkle-tree'
import { zklogin } from '@shield-labs/zklogin'

const registry = new zklogin.PublicKeyRegistry()
const keys = await registry.getPublicKeys()
if (!keys.length) throw new Error('Google JWK registry returned no keys')
const tree = StandardMerkleTree.of(keys.map((key) => [key.hash]), ['bytes32'])
const frozenKeys = keys.map((key, index) => ({ ...key, jwkProof: tree.getProof(index) }))
const snapshot = { fetchedAt: new Date().toISOString(), source: 'https://www.googleapis.com/oauth2/v3/certs', root: tree.root, tree: tree.dump(), keys: frozenKeys }
await writeFile(new URL('../apps/web/src/generated/jwk-snapshot.json', import.meta.url), `${JSON.stringify(snapshot, null, 2)}\n`)
console.log(tree.root)
