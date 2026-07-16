/** Fiat amounts the user can pick from (USD). */
export const ONRAMP_AMOUNTS = [10, 25, 50] as const
export type OnrampAmount = (typeof ONRAMP_AMOUNTS)[number]

export const ONRAMP_CHAIN_ID = 8453
export const ONRAMP_CHAIN_NAME = 'Base'

export type OnrampStage =
  | 'extension_check'  // checking if Peer extension is installed
  | 'extension_install' // extension not found — show install prompt
  | 'extension_connect' // extension found but needs connection approval
  | 'idle'             // choosing provider and amount
  | 'fetching'          // fetching live quote
  | 'ready'             // quote loaded, waiting to confirm
  | 'paying'            // Peer extension open, user completing payment
  | 'fulfilling'        // fulfilling intent on-chain
  | 'done'              // USDC received
  | 'error'             // something went wrong
