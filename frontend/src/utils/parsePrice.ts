/**
 * Parses a user-typed price string into one of three outcomes:
 *   { kind: 'value',   value: number }   — ready to submit (integer)
 *   { kind: 'confirm', proposed: number } — bare number < 1000; caller should
 *                                           ask "You entered $X,000. Is that correct?"
 *   { kind: 'invalid' }                  — non-numeric or empty; show error
 *
 * Rules:
 *   $, commas, leading/trailing whitespace → stripped before parsing
 *   Suffix K/k → ×1 000 (explicit unit, no confirmation)
 *   Suffix M/m → ×1 000 000 (explicit unit, no confirmation)
 *   Bare number ≥ 1 000 → value (literal)
 *   Bare number < 1 000 (and > 0) → confirm with proposed = n × 1 000
 *   Result is always Math.round'd to an integer
 */

export type ParsePriceResult =
  | { kind: 'value';   value: number }
  | { kind: 'confirm'; proposed: number }
  | { kind: 'invalid' }

export function parsePrice(input: string): ParsePriceResult {
  const trimmed = input.trim()
  if (!trimmed) return { kind: 'invalid' }

  // Strip $ and commas; keep spaces so we can detect the suffix separately.
  const cleaned = trimmed.replace(/[$,]/g, '')

  // K / M suffix (explicit unit → no confirmation regardless of magnitude)
  const suffixMatch = cleaned.match(/^\s*([\d.]+)\s*([kKmM])$/)
  if (suffixMatch) {
    const num = parseFloat(suffixMatch[1])
    if (!isFinite(num) || num <= 0) return { kind: 'invalid' }
    const multiplier = /[kK]/.test(suffixMatch[2]) ? 1_000 : 1_000_000
    return { kind: 'value', value: Math.round(num * multiplier) }
  }

  // Bare number: strip remaining whitespace and parse
  const bare = cleaned.replace(/\s/g, '')
  if (!bare) return { kind: 'invalid' }

  const num = parseFloat(bare)
  if (!isFinite(num) || num <= 0) return { kind: 'invalid' }

  const rounded = Math.round(num)
  if (rounded < 1_000) {
    return { kind: 'confirm', proposed: rounded * 1_000 }
  }
  return { kind: 'value', value: rounded }
}
