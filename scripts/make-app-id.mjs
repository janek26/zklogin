import { keccak256, toBytes } from 'viem'

const clientId = process.env.GOOGLE_CLIENT_ID
if (!clientId) throw new Error('GOOGLE_CLIENT_ID is required')
console.log(keccak256(toBytes(`zklogin-native-wallet-v1|${clientId}|kernel-index=0`)))
