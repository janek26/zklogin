import {
  createPeerExtensionSdk,
  type PeerExtensionSdk,
  type PeerMetadataMessage,
  type PeerMetadataRow,
  type PeerBuyerTeePaymentCapture,
} from '@zkp2p/sdk'

// ---------------------------------------------------------------------------
// Singleton — one Peer SDK per page
// ---------------------------------------------------------------------------

let _sdk: PeerExtensionSdk | null = null

function getSdk(): PeerExtensionSdk {
  if (!_sdk) {
    _sdk = createPeerExtensionSdk()
  }
  return _sdk
}

export type PeerState = 'needs_install' | 'needs_connection' | 'ready'

export async function checkPeerState(): Promise<PeerState> {
  return getSdk().getState()
}

export async function requestPeerConnection(): Promise<boolean> {
  return getSdk().requestConnection()
}

export function openPeerInstall(): void {
  getSdk().openInstallPage()
}

// ---------------------------------------------------------------------------
// State & version
// ---------------------------------------------------------------------------

/**
 * Check that the Peer extension is installed, connected, and >= 0.6.3.
 * Returns `true` when ready, or throws with a user-facing message.
 */
export async function ensurePeerReady(): Promise<true> {
  const sdk = getSdk()
  const state = await sdk.getState()

  if (state === 'needs_install') {
    sdk.openInstallPage()
    throw new Error(
      'Peer extension is required for onramp. Install page opened.',
    )
  }

  if (state === 'needs_connection') {
    const approved = await sdk.requestConnection()
    if (!approved) throw new Error('Peer extension connection was declined.')
  }

  const version = await sdk.getVersion()
  if (!isVersionAtLeast(version, 0, 6, 3)) {
    throw new Error(
      `Peer extension 0.6.3+ required (found ${version}). Please update.`,
    )
  }

  return true
}

function isVersionAtLeast(
  version: string,
  maj: number,
  min: number,
  patch: number,
): boolean {
  const [a = 0, b = 0, c = 0] = version.split('.').map(Number)
  if (a !== maj) return a > maj
  if (b !== min) return b > min
  return c >= patch
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

function isBuyerTeeParams(
  value: unknown,
): value is Record<string, string | number | boolean> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (v) =>
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
    )
  )
}

/**
 * Pick the payment row that matches expected amount/recipient.
 * Uses `originalIndex` (not filtered-array index) for the provider metadata index.
 */
export function selectPaymentRow(
  rows: PeerMetadataRow[],
  expected: { amount?: string; recipient?: string },
): PeerMetadataRow | null {
  const visible = rows.filter(
    (row) => !row.hidden && isBuyerTeeParams(row.params),
  )

  return (
    visible.find(
      (row) =>
        (!expected.amount || row.amount === expected.amount) &&
        (!expected.recipient || row.recipient === expected.recipient),
    ) ?? null
  )
}

// ---------------------------------------------------------------------------
// Capture trigger
// ---------------------------------------------------------------------------

export interface BuyerTeeConfig {
  actionPlatform: string
  actionType: string
  attestationActionType?: string
  includeMetadataIndex: boolean
  platform: string
}

export interface BuyerTeeProof {
  proofType: 'buyerTee'
  encryptedSessionMaterial: string
  params: Record<string, string | number | boolean>
  actionPlatform: string
  actionType: string
}

export function buildBuyerTeeProof(
  row: PeerMetadataRow,
  capture: PeerBuyerTeePaymentCapture | null | undefined,
  config: BuyerTeeConfig,
): BuyerTeeProof {
  if (!capture?.encryptedSessionMaterial || !isBuyerTeeParams(row.params)) {
    throw new Error('Payment row is missing Buyer TEE capture data.')
  }

  if (config.includeMetadataIndex && !Number.isInteger(row.originalIndex)) {
    throw new Error('Payment row is missing its provider metadata index.')
  }

  return {
    proofType: 'buyerTee',
    encryptedSessionMaterial: capture.encryptedSessionMaterial,
    params: {
      ...row.params,
      ...(config.includeMetadataIndex ? { index: row.originalIndex } : {}),
    },
    actionPlatform: config.actionPlatform,
    actionType: config.attestationActionType ?? config.actionType,
  }
}

// ---------------------------------------------------------------------------
// Full Buyer TEE flow: register listener → authenticate
// ---------------------------------------------------------------------------

export interface StartBuyerTeeParams {
  config: BuyerTeeConfig
  attestationServiceUrl: string
  onCapture: (proof: BuyerTeeProof) => void
  onError: (error: Error) => void
}

/**
 * Register metadata listener then open Peer authenticate().
 * Returns an unsubscribe function.
 */
export function startBuyerTeeCapture(params: StartBuyerTeeParams): () => void {
  const sdk = getSdk()
  const { config, attestationServiceUrl, onCapture, onError } = params

  const unsubscribe = sdk.onMetadataMessage((msg: PeerMetadataMessage) => {
    try {
      if (msg.errorMessage) throw new Error(msg.errorMessage)

      const row = selectPaymentRow(msg.metadata, {})
      if (!row) throw new Error('No payment row matched.')

      const proof = buildBuyerTeeProof(row, msg.buyerTeeCapture, config)
      onCapture(proof)
    } catch (err) {
      onError(err instanceof Error ? err : new Error('Buyer TEE capture failed'))
    } finally {
      unsubscribe()
    }
  })

  sdk.authenticate({
    actionType: config.actionType,
    attestationActionType: config.attestationActionType ?? config.actionType,
    attestationServiceUrl,
    captureMode: 'buyerTee',
    platform: config.platform,
  })

  return unsubscribe
}
