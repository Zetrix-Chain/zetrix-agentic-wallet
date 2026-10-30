/**
 * The optional `expirationDate` of an agent credential: YYYY-MM-DD, in the future. MBI checks it too, but a bad date there costs a counted
 * application (the per-address limit), so a plain mistake is caught here and nothing is sent. MBI still decides the upper bound.
 * The date is read as midnight UTC at the start of that day, and "in the future" means now is before that instant. In Malaysia (UTC+8) a
 * date D is therefore accepted until 08:00 on D and refused from then on. The caller sends the trimmed value.
 */
export function expirationProblem(value: string | undefined, now: Date): string | undefined {
  if (value === undefined || value === '') return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : undefined
  const real = date !== undefined && date.toISOString().slice(0, 10) === value.trim()
  if (!real) return `expirationDate must be a real date written YYYY-MM-DD (got "${value}"); leave it out to take MBI's default.`
  if (date.getTime() <= now.getTime()) return `expirationDate must be in the future (got "${value}"); leave it out to take MBI's default.`
  return undefined
}
