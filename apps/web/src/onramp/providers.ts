import type { BuyerTeeConfig } from './peer'

// ---------------------------------------------------------------------------
// All supported payment platforms (from @zkp2p/sdk PAYMENT_PLATFORMS)
// ---------------------------------------------------------------------------

export type PlatformId =
  | 'venmo'
  | 'cashapp'
  | 'zelle'
  | 'paypal'
  | 'revolut'
  | 'wise'
  | 'monzo'
  | 'chime'
  | 'mercadopago'
  | 'luxon'
  | 'n26'

export interface PlatformMeta {
  id: PlatformId
  /** Display name. */
  label: string
  /** Human-readable description shown in the selector. */
  description: string
  /** Buyer TEE config for Peer extension. */
  buyerTee: BuyerTeeConfig
}

// ---------------------------------------------------------------------------
// Per-platform Buyer TEE configs
// ---------------------------------------------------------------------------
// includeMetadataIndex only for: Venmo, Cash App, Revolut, Zelle.
// NOT for: PayPal, Wise, Monzo, Chime, Mercado Pago, Luxon, N26.

function cfg(id: PlatformId, needsIndex: boolean): BuyerTeeConfig {
  return {
    actionPlatform: id,
    actionType: `transfer_${id}`,
    includeMetadataIndex: needsIndex,
    platform: id,
  }
}

export const PLATFORMS: Record<PlatformId, PlatformMeta> = {
  venmo:      { id: 'venmo',      label: 'Venmo',      description: 'Send with Venmo balance, bank, or card',       buyerTee: cfg('venmo', true) },
  cashapp:    { id: 'cashapp',    label: 'Cash App',    description: 'Send from your Cash App balance',               buyerTee: cfg('cashapp', true) },
  revolut:    { id: 'revolut',    label: 'Revolut',     description: 'Send from Revolut account',                     buyerTee: cfg('revolut', true) },
  zelle:      { id: 'zelle',      label: 'Zelle',       description: 'Send from your bank via Zelle',                 buyerTee: cfg('zelle', true) },
  paypal:     { id: 'paypal',     label: 'PayPal',      description: 'Send from your PayPal balance or linked card',  buyerTee: cfg('paypal', false) },
  wise:       { id: 'wise',       label: 'Wise',        description: 'Send from your Wise account',                   buyerTee: cfg('wise', false) },
  monzo:      { id: 'monzo',      label: 'Monzo',       description: 'Send from your Monzo account',                  buyerTee: cfg('monzo', false) },
  chime:      { id: 'chime',      label: 'Chime',       description: 'Send from your Chime account',                  buyerTee: cfg('chime', false) },
  mercadopago:{ id: 'mercadopago',label: 'Mercado Pago',description: 'Send from your Mercado Pago account',           buyerTee: cfg('mercadopago', false) },
  luxon:      { id: 'luxon',      label: 'Luxon',       description: 'Send from your Luxon account',                  buyerTee: cfg('luxon', false) },
  n26:        { id: 'n26',        label: 'N26',         description: 'Send from your N26 account',                    buyerTee: cfg('n26', false) },
}

// ---------------------------------------------------------------------------
// Country → preferred platform ordering (most popular first)
// ---------------------------------------------------------------------------

type CountryOrder = PlatformId[]

const COUNTRY_PLATFORM_ORDER: Record<string, CountryOrder> = {
  // United States
  US: ['venmo', 'cashapp', 'zelle', 'paypal', 'wise', 'revolut'],
  // United Kingdom
  GB: ['monzo', 'revolut', 'wise', 'paypal', 'venmo'],
  // Eurozone
  DE: ['revolut', 'n26', 'wise', 'paypal'],
  FR: ['revolut', 'n26', 'wise', 'paypal', 'luxon'],
  ES: ['revolut', 'n26', 'wise', 'paypal'],
  IT: ['revolut', 'n26', 'wise', 'paypal'],
  NL: ['revolut', 'n26', 'wise', 'paypal'],
  IE: ['revolut', 'n26', 'wise', 'paypal'],
  AT: ['revolut', 'n26', 'wise', 'paypal'],
  BE: ['revolut', 'n26', 'wise', 'paypal'],
  PT: ['revolut', 'n26', 'wise', 'paypal'],
  // Nordics
  SE: ['revolut', 'wise', 'paypal'],
  DK: ['revolut', 'wise', 'paypal'],
  NO: ['revolut', 'wise', 'paypal'],
  FI: ['revolut', 'wise', 'paypal'],
  // LATAM
  BR: ['mercadopago', 'wise', 'paypal'],
  MX: ['mercadopago', 'wise', 'paypal'],
  AR: ['mercadopago', 'wise', 'paypal'],
  CO: ['mercadopago', 'wise', 'paypal'],
  CL: ['mercadopago', 'wise', 'paypal'],
  // Canada
  CA: ['wise', 'paypal', 'revolut'],
  // Australia / NZ
  AU: ['wise', 'paypal', 'revolut'],
  NZ: ['wise', 'paypal', 'revolut'],
  // Asia
  JP: ['wise', 'paypal'],
  KR: ['wise', 'paypal'],
  SG: ['wise', 'paypal', 'revolut'],
  IN: ['wise', 'paypal'],
  // Africa
  ZA: ['wise', 'paypal'],
  NG: ['wise', 'paypal'],
  KE: ['wise', 'paypal'],
}

/** Fallback ordering — works everywhere. */
const FALLBACK_ORDER: CountryOrder = ['wise', 'paypal', 'revolut', 'venmo', 'cashapp', 'monzo']

/**
 * Detect user's country code from `navigator.language` (e.g. "en-US" → "US").
 * Falls back to timezone-based guess, then to empty string.
 */
export function detectCountry(): string {
  // Local dev: force Germany so provider ordering is testable.
  if (typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(window.location.hostname || '')) {
    return 'DE'
  }
  const lang = (
    navigator.language ||
    (navigator as { userLanguage?: string }).userLanguage ||
    ''
  ).toUpperCase()

  // Extract region from locale like "en-US", "pt-BR", "fr"
  const fromLocale = lang.includes('-') ? lang.split('-')[1] : ''

  if (fromLocale && COUNTRY_PLATFORM_ORDER[fromLocale]) return fromLocale

  // Secondary: timezone guess
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (tz) {
      if (tz.startsWith('America/New_York') || tz.startsWith('America/Chicago') ||
          tz.startsWith('America/Denver') || tz.startsWith('America/Los_Angeles')) return 'US'
      if (tz.startsWith('Europe/London')) return 'GB'
      if (tz.startsWith('Europe/Paris') || tz.startsWith('Europe/Berlin') ||
          tz.startsWith('Europe/Madrid') || tz.startsWith('Europe/Rome') ||
          tz.startsWith('Europe/Amsterdam') || tz.startsWith('Europe/Brussels') ||
          tz.startsWith('Europe/Vienna') || tz.startsWith('Europe/Lisbon') ||
          tz.startsWith('Europe/Dublin')) return 'DE'
      if (tz.startsWith('Europe/Stockholm') || tz.startsWith('Europe/Oslo') ||
          tz.startsWith('Europe/Copenhagen') || tz.startsWith('Europe/Helsinki')) return 'SE'
      if (tz.startsWith('America/Sao_Paulo')) return 'BR'
      if (tz.startsWith('America/Mexico_City')) return 'MX'
      if (tz.startsWith('America/Buenos_Aires')) return 'AR'
      if (tz.startsWith('America/Toronto') || tz.startsWith('America/Vancouver')) return 'CA'
      if (tz.startsWith('Australia/')) return 'AU'
      if (tz.startsWith('Pacific/Auckland')) return 'NZ'
      if (tz.startsWith('Asia/Tokyo')) return 'JP'
      if (tz.startsWith('Asia/Seoul')) return 'KR'
      if (tz.startsWith('Asia/Singapore')) return 'SG'
      if (tz.startsWith('Asia/Kolkata')) return 'IN'
      if (tz.startsWith('Africa/Johannesburg')) return 'ZA'
      if (tz.startsWith('Africa/Lagos')) return 'NG'
      if (tz.startsWith('Africa/Nairobi')) return 'KE'
    }
  } catch { /* ignore */ }

  return ''
}

/**
 * Return platforms ordered by the user's detected country,
 * with the country's preferred platforms first, then fallback.
 */
export function orderedPlatforms(): PlatformMeta[] {
  const country = detectCountry()
  const order = COUNTRY_PLATFORM_ORDER[country] ?? FALLBACK_ORDER
  const seen = new Set<PlatformId>()

  const result: PlatformMeta[] = []
  for (const id of order) {
    if (!seen.has(id)) {
      seen.add(id)
      result.push(PLATFORMS[id])
    }
  }
  // Append any remaining platforms not in the country order
  for (const id of Object.keys(PLATFORMS) as PlatformId[]) {
    if (!seen.has(id)) {
      result.push(PLATFORMS[id])
    }
  }

  return result
}

/** Convert a 2-letter country code to its flag emoji (e.g. "US" → "🇺🇸"). */
export function countryFlag(code: string): string {
  if (code.length !== 2) return ''
  const a = code.toUpperCase().codePointAt(0) ?? 0
  const b = code.toUpperCase().codePointAt(1) ?? 0
  if (a < 65 || a > 90 || b < 65 || b > 90) return ''
  return String.fromCodePoint(0x1F1E6 + a - 65) + String.fromCodePoint(0x1F1E6 + b - 65)
}
