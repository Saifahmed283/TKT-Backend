const MIN_LENGTH = 10
const MAX_LENGTH = 128

const UPPER = /[A-Z]/
const LOWER = /[a-z]/
const DIGIT = /\d/
const SYMBOL = /[^A-Za-z0-9]/

export type PasswordPolicyResult = { ok: true } | { ok: false; reason: string }

export function validatePasswordStrength(password: string): PasswordPolicyResult {
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, reason: 'Password is required' }
  }
  if (password.length < MIN_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MIN_LENGTH} characters` }
  }
  if (password.length > MAX_LENGTH) {
    return { ok: false, reason: `Password must be at most ${MAX_LENGTH} characters` }
  }
  if (/\s/.test(password)) {
    return { ok: false, reason: 'Password must not contain spaces' }
  }
  const classes = [UPPER.test(password), LOWER.test(password), DIGIT.test(password), SYMBOL.test(password)].filter(Boolean).length
  if (classes < 3) {
    return { ok: false, reason: 'Password must include at least 3 of: uppercase, lowercase, number, symbol' }
  }
  return { ok: true }
}