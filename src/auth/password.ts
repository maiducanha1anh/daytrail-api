import bcrypt from 'bcryptjs'

export const MIN_PASSWORD_CHARACTERS = 12
export const MAX_PASSWORD_UTF8_BYTES = 72
const BCRYPT_ROUNDS = 12

export function passwordValidationError(password: unknown) {
  if (typeof password !== 'string') return 'Mật khẩu phải là chuỗi.'
  if (Array.from(password).length < MIN_PASSWORD_CHARACTERS) return `Mật khẩu phải có ít nhất ${MIN_PASSWORD_CHARACTERS} ký tự.`
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_UTF8_BYTES) return `Mật khẩu không được vượt quá ${MAX_PASSWORD_UTF8_BYTES} byte UTF-8.`
  return undefined
}

export function hashPassword(password: string) {
  return bcrypt.hash(password, BCRYPT_ROUNDS)
}

export function verifyPassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash)
}
