import { createHash } from 'node:crypto'
import express, { type NextFunction, type Request, type Response } from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { AccountActionError, changePassword, resetPassword, sendEmailVerification, sendPasswordReset, verifyEmail } from '../auth/accountLifecycle.js'
import { hashPassword, passwordValidationError, verifyPassword } from '../auth/password.js'
import { createSession, clearSessionCookieOptions, hashSessionToken, SESSION_COOKIE_NAME, sessionCookieOptions } from '../auth/session.js'
import type { EmailSender } from '../email/sender.js'
import { requireAuthentication } from '../middleware/authentication.js'
import { requireAllowedOrigin, requireJson } from '../middleware/requestSecurity.js'
import { Session } from '../models/Session.js'
import { User, type UserDocument } from '../models/User.js'

type AuthRouterOptions = {
  cookieSecure: boolean
  emailCooldownMs: number
  emailSender: EmailSender
  frontendBaseUrl: string
  frontendOrigin: string
  rateLimitMax: number
  rateLimitWindowMs: number
  sessionTtlMs: number
}

type RegisterInput = {
  displayName: string
  email: string
  password: string
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const INVALID_LOGIN_MESSAGE = 'Email hoặc mật khẩu không đúng.'
const RESET_REQUEST_MESSAGE = 'Nếu email này có tài khoản, bạn sẽ nhận được hướng dẫn đặt lại mật khẩu.'
const DUMMY_PASSWORD_HASH = hashPassword('daytrail-invalid-password')

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase()
}

function validEmail(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const email = normalizeEmail(value)
  return email.length <= 254 && EMAIL_PATTERN.test(email)
}

function validateRegisterInput(body: unknown): { error: string } | { value: RegisterInput } {
  if (!isRecord(body)) return { error: 'Dữ liệu đăng ký không hợp lệ.' }
  if (typeof body.displayName !== 'string') return { error: 'Tên hiển thị phải là chuỗi.' }
  const displayName = body.displayName.trim()
  if (!displayName || displayName.length > 80) return { error: 'Tên hiển thị phải có từ 1 đến 80 ký tự.' }
  if (!validEmail(body.email)) return { error: 'Email không hợp lệ.' }
  const passwordError = passwordValidationError(body.password)
  if (passwordError) return { error: passwordError }
  return { value: { displayName, email: normalizeEmail(body.email), password: body.password as string } }
}

function validateNewPassword(body: unknown) {
  if (!isRecord(body) || typeof body.token !== 'string' || !TOKEN_PATTERN.test(body.token)) {
    return { error: 'Liên kết không hợp lệ.', code: 'TOKEN_INVALID_OR_EXPIRED' as const }
  }
  const passwordError = passwordValidationError(body.newPassword)
  if (passwordError) return { error: passwordError }
  return { value: { newPassword: body.newPassword as string, token: body.token } }
}

function validateChangePassword(body: unknown) {
  if (!isRecord(body) || typeof body.currentPassword !== 'string') return { error: 'Vui lòng nhập mật khẩu hiện tại.' }
  const passwordError = passwordValidationError(body.newPassword)
  if (passwordError) return { error: passwordError }
  return { value: { currentPassword: body.currentPassword, newPassword: body.newPassword as string } }
}

function publicUser(user: UserDocument) {
  return {
    createdAt: user.createdAt,
    displayName: user.displayName,
    email: user.email,
    emailVerifiedAt: user.emailVerifiedAt ?? null,
    id: user._id.toString(),
    updatedAt: user.updatedAt,
  }
}

function isDuplicateKeyError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000)
}

function createLimiter(windowMs: number, limit: number, keyGenerator?: (request: Request) => string) {
  return rateLimit({
    handler: (_request, response) => response.status(429).json({ code: 'RATE_LIMITED', error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.' }),
    keyGenerator,
    legacyHeaders: false,
    limit,
    standardHeaders: 'draft-8',
    windowMs,
  })
}

function hashedTargetKey(request: Request) {
  const email = isRecord(request.body) && typeof request.body.email === 'string' ? normalizeEmail(request.body.email) : ''
  const target = createHash('sha256').update(email).digest('hex')
  return `${ipKeyGenerator(request.ip ?? '')}:${target}`
}

function authenticatedKey(request: Request) {
  return request.auth?.userId ? `user:${request.auth.userId}` : `ip:${ipKeyGenerator(request.ip ?? '')}`
}

async function register(request: Request, response: Response, options: AuthRouterOptions) {
  const result = validateRegisterInput(request.body)
  if ('error' in result) return void response.status(400).json({ error: result.error })
  try {
    const user = await User.create({
      credentialVersion: 0,
      displayName: result.value.displayName,
      email: result.value.email,
      passwordHash: await hashPassword(result.value.password),
    })
    const verificationEmailSent = await sendEmailVerification({
      displayName: user.displayName,
      email: user.email,
      emailSender: options.emailSender,
      frontendBaseUrl: options.frontendBaseUrl,
      userId: user._id,
    })
    response.status(201).json({ user: publicUser(user), verificationEmailSent })
  } catch (error: unknown) {
    if (isDuplicateKeyError(error)) return void response.status(409).json({ error: 'Email đã được sử dụng.' })
    throw error
  }
}

async function login(request: Request, response: Response, options: AuthRouterOptions) {
  const body = isRecord(request.body) ? request.body : {}
  if (!validEmail(body.email) || typeof body.password !== 'string') return void response.status(401).json({ error: INVALID_LOGIN_MESSAGE })
  const email = normalizeEmail(body.email)
  const password = body.password
  if (passwordValidationError(password)) return void response.status(401).json({ error: INVALID_LOGIN_MESSAGE })
  const user = await User.findOne({ email }).select('+passwordHash')
  const passwordMatches = user
    ? await verifyPassword(password, user.passwordHash)
    : await verifyPassword(password, await DUMMY_PASSWORD_HASH).then(() => false)
  if (!user || !passwordMatches) return void response.status(401).json({ error: INVALID_LOGIN_MESSAGE })
  const credentialVersion = user.credentialVersion ?? 0
  const { session, token } = await createSession(user._id, options.sessionTtlMs, credentialVersion)
  const versionFilter = credentialVersion === 0
    ? { $or: [{ credentialVersion: 0 }, { credentialVersion: { $exists: false } }] }
    : { credentialVersion }
  const stillCurrent = await User.exists({ _id: user._id, passwordHash: user.passwordHash, ...versionFilter })
  if (!stillCurrent) {
    await Session.deleteOne({ _id: session._id })
    return void response.status(401).json({ error: INVALID_LOGIN_MESSAGE })
  }
  response.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions(options.cookieSecure, options.sessionTtlMs))
  response.json({ user: publicUser(user) })
}

async function me(request: Request, response: Response) {
  const user = await User.findById(request.auth?.userId)
  if (!user) return void response.status(401).json({ error: 'Bạn chưa đăng nhập hoặc phiên đã hết hạn.' })
  response.json({ user: publicUser(user) })
}

async function logout(request: Request, response: Response, cookieSecure: boolean) {
  const token = request.cookies?.[SESSION_COOKIE_NAME]
  if (typeof token === 'string' && token) await Session.deleteOne({ tokenHash: hashSessionToken(token) })
  response.clearCookie(SESSION_COOKIE_NAME, clearSessionCookieOptions(cookieSecure))
  response.status(204).end()
}

async function requestPasswordReset(request: Request, response: Response, options: AuthRouterOptions) {
  response.set('Cache-Control', 'no-store')
  if (isRecord(request.body) && validEmail(request.body.email)) {
    const user = await User.findOne({ email: normalizeEmail(request.body.email) })
    if (user) await sendPasswordReset({
      displayName: user.displayName,
      email: user.email,
      emailSender: options.emailSender,
      frontendBaseUrl: options.frontendBaseUrl,
      userId: user._id,
    })
  }
  response.status(202).json({ message: RESET_REQUEST_MESSAGE })
}

async function confirmPasswordReset(request: Request, response: Response, options: AuthRouterOptions) {
  response.set('Cache-Control', 'no-store')
  const result = validateNewPassword(request.body)
  if ('error' in result) return void response.status(400).json({ code: result.code, error: result.error })
  const outcome = await resetPassword({ ...result.value, emailSender: options.emailSender })
  response.clearCookie(SESSION_COOKIE_NAME, clearSessionCookieOptions(options.cookieSecure))
  response.json({ message: 'Mật khẩu đã được đặt lại. Hãy đăng nhập bằng mật khẩu mới.', ...outcome })
}

async function changeCurrentPassword(request: Request, response: Response, options: AuthRouterOptions) {
  response.set('Cache-Control', 'no-store')
  const result = validateChangePassword(request.body)
  if ('error' in result) return void response.status(400).json({ error: result.error })
  const outcome = await changePassword({ ...result.value, emailSender: options.emailSender, userId: request.auth?.userId ?? '' })
  response.clearCookie(SESSION_COOKIE_NAME, clearSessionCookieOptions(options.cookieSecure))
  response.json({ message: 'Mật khẩu đã đổi. Tất cả phiên cũ đã được thu hồi; hãy đăng nhập lại.', ...outcome })
}

async function resendVerification(request: Request, response: Response, options: AuthRouterOptions) {
  response.set('Cache-Control', 'no-store')
  const user = await User.findById(request.auth?.userId)
  if (!user) return void response.status(401).json({ error: 'Bạn chưa đăng nhập hoặc phiên đã hết hạn.' })
  if (user.emailVerifiedAt) return void response.json({ message: 'Email đã được xác minh.', verificationEmailSent: false })
  const verificationEmailSent = await sendEmailVerification({
    displayName: user.displayName,
    email: user.email,
    emailSender: options.emailSender,
    frontendBaseUrl: options.frontendBaseUrl,
    userId: user._id,
  })
  if (!verificationEmailSent) return void response.status(503).json({ code: 'EMAIL_UNAVAILABLE', error: 'Chưa thể gửi email xác minh. Vui lòng thử lại sau.' })
  response.json({ message: 'Email xác minh đã được gửi.', verificationEmailSent: true })
}

async function confirmVerification(request: Request, response: Response) {
  response.set('Cache-Control', 'no-store')
  if (!isRecord(request.body) || typeof request.body.token !== 'string' || !TOKEN_PATTERN.test(request.body.token)) {
    return void response.status(400).json({ code: 'TOKEN_INVALID_OR_EXPIRED', error: 'Liên kết xác minh không hợp lệ hoặc đã hết hạn.' })
  }
  await verifyEmail(request.body.token)
  response.json({ message: 'Email đã được xác minh.' })
}

export function createAuthRouter(options: AuthRouterOptions) {
  const router = express.Router()
  const allowedOrigin = requireAllowedOrigin(options.frontendOrigin)
  const parseJson = express.json({ limit: '16kb' })
  const standardLimiter = createLimiter(options.rateLimitWindowMs, options.rateLimitMax)
  const accountActionLimiter = createLimiter(options.rateLimitWindowMs, Math.max(3, Math.min(options.rateLimitMax, 10)), authenticatedKey)
  const emailCooldownLimiter = createLimiter(options.emailCooldownMs, 1, hashedTargetKey)
  const resendCooldownLimiter = createLimiter(options.emailCooldownMs, 1, authenticatedKey)

  router.post('/register', allowedOrigin, requireJson, parseJson, standardLimiter, (request, response) => register(request, response, options))
  router.post('/login', allowedOrigin, requireJson, parseJson, standardLimiter, (request, response) => login(request, response, options))
  router.get('/me', requireAuthentication, (request, response) => me(request, response))
  router.post('/logout', allowedOrigin, requireJson, parseJson, (request, response) => logout(request, response, options.cookieSecure))
  router.post('/password-reset/request', allowedOrigin, requireJson, parseJson, emailCooldownLimiter, (request, response) => requestPasswordReset(request, response, options))
  router.post('/password-reset/confirm', allowedOrigin, requireJson, parseJson, standardLimiter, (request, response) => confirmPasswordReset(request, response, options))
  router.post('/password/change', allowedOrigin, requireAuthentication, requireJson, parseJson, accountActionLimiter, (request, response) => changeCurrentPassword(request, response, options))
  router.post('/email-verification/resend', allowedOrigin, requireAuthentication, requireJson, parseJson, resendCooldownLimiter, (request, response) => resendVerification(request, response, options))
  router.post('/email-verification/confirm', allowedOrigin, requireJson, parseJson, standardLimiter, (request, response) => confirmVerification(request, response))

  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (!(error instanceof AccountActionError)) return next(error)
    const status = error.code === 'PASSWORD_CHANGED' ? 409 : 400
    response.set('Cache-Control', 'no-store').status(status).json({ code: error.code, error: error.message })
  })
  return router
}
