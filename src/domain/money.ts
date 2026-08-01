/**
 * All money in this codebase is stored and computed as integer **cents**
 * (bigint in the DB, number in JS — JS numbers are safe integers up to 2^53).
 *
 * Never use floating-point arithmetic on dollar amounts. Convert at the edges:
 *   - Incoming from upstream (float dollars) → toCents()
 *   - Displaying to users → formatCents()
 */

/** Convert a dollar float from the upstream API to integer cents. */
export function toCents(dollars: number): number {
  // toFixed(6) trims binary-float noise (40 * 1.1 === 44.000000000000006)
  return Math.round(Number(dollars.toFixed(6)) * 100);
}

/** Format integer cents as a dollar string for display, e.g. 130 → "$1.30" */
export function formatCents(cents: number): string {
  return '$' + (cents / 100).toFixed(2);
}

/** Ceiling-round a fractional cent value to the next whole cent. */
export function ceilCents(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.ceil(Number(value.toFixed(6)));
}
