import express, { type Request, type Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { createSession, clearSessionCookieOptions, hashSessionToken, SESSION_COOKIE_NAME, sessionCookieOptions } from '../auth/session.js'
import { hashPassword, passwordValidationError, verifyPassword } from '../auth/password.js'
import { requireAuthentication } from '../middleware/authentication.js'
import { requireAllowedOrigin, requireJson } from '../middleware/requestSecurity.js'
import { Session } from '../models/Session.js'
import { User, type UserDocument } from '../models/User.js'

type AuthRouterOptions = {
  cookieSecure: boolean
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
const INVALID_LOGIN_MESSAGE = 'Email hoặc mật khẩu không đúng.'
const DUMMY_PASSWORD_HASH = hashPassword('daytrail-invalid-password')

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase()
}

function validateRegisterInput(body: unknown): { error: string } | { value: RegisterInput } {
  if (!isRecord(body)) return { error: 'Dữ liệu đăng ký không hợp lệ.' }
  if (typeof body.displayName !== 'string') return { error: 'Tên hiển thị phải là chuỗi.' }
  const displayName = body.displayName.trim()
  if (!displayName || displayName.length > 80) return { error: 'Tên hiển thị phải có từ 1 đến 80 ký tự.' }
  if (typeof body.email !== 'string') return { error: 'Email phải là chuỗi.' }
  const email = normalizeEmail(body.email)
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return { error: 'Email không hợp lệ.' }
  const passwordError = passwordValidationError(body.password)
  if (passwordError) return { error: passwordError }
  return { value: { displayName, email, password: body.password as string } }
}

function publicUser(user: UserDocument) {
  return {
    createdAt: user.createdAt,
    displayName: user.displayName,
    email: user.email,
    id: user._id.toString(),
    updatedAt: user.updatedAt,
  }
}

function isDuplicateKeyError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000)
}

function createAuthLimiter(windowMs: number, limit: number) {
  return rateLimit({
    handler: (_request, response) => response.status(429).json({ error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.' }),
    legacyHeaders: false,
    limit,
    standardHeaders: 'draft-8',
    windowMs,
  })
}

async function register(request: Request, response: Response) {
  const result = validateRegisterInput(request.body)
  if ('error' in result) {
    response.status(400).json({ error: result.error })
    return
  }
  try {
    const user = await User.create({
      displayName: result.value.displayName,
      email: result.value.email,
      passwordHash: await hashPassword(result.value.password),
    })
    response.status(201).json({ user: publicUser(user) })
  } catch (error: unknown) {
    if (isDuplicateKeyError(error)) {
      response.status(409).json({ error: 'Email đã được sử dụng.' })
      return
    }
    throw error
  }
}

async function login(request: Request, response: Response, options: AuthRouterOptions) {
  const body = isRecord(request.body) ? request.body : {}
  if (typeof body.email !== 'string' || typeof body.password !== 'string') {
    response.status(401).json({ error: INVALID_LOGIN_MESSAGE })
    return
  }
  const email = normalizeEmail(body.email)
  const password = body.password
  if (!EMAIL_PATTERN.test(email) || email.length > 254 || passwordValidationError(password)) {
    response.status(401).json({ error: INVALID_LOGIN_MESSAGE })
    return
  }
  const user = await User.findOne({ email }).select('+passwordHash')
  const passwordMatches = user
    ? await verifyPassword(password, user.passwordHash)
    : await verifyPassword(password, await DUMMY_PASSWORD_HASH).then(() => false)
  if (!user || !passwordMatches) {
    response.status(401).json({ error: INVALID_LOGIN_MESSAGE })
    return
  }
  const { token } = await createSession(user._id, options.sessionTtlMs)
  response.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions(options.cookieSecure, options.sessionTtlMs))
  response.json({ user: publicUser(user) })
}

async function me(request: Request, response: Response) {
  const user = await User.findById(request.auth?.userId)
  if (!user) {
    response.status(401).json({ error: 'Bạn chưa đăng nhập hoặc phiên đã hết hạn.' })
    return
  }
  response.json({ user: publicUser(user) })
}

async function logout(request: Request, response: Response, cookieSecure: boolean) {
  const token = request.cookies?.[SESSION_COOKIE_NAME]
  if (typeof token === 'string' && token) await Session.deleteOne({ tokenHash: hashSessionToken(token) })
  response.clearCookie(SESSION_COOKIE_NAME, clearSessionCookieOptions(cookieSecure))
  response.status(204).end()
}

export function createAuthRouter(options: AuthRouterOptions) {
  const router = express.Router()
  const allowedOrigin = requireAllowedOrigin(options.frontendOrigin)
  const parseJson = express.json({ limit: '16kb' })
  const registerLimiter = createAuthLimiter(options.rateLimitWindowMs, options.rateLimitMax)
  const loginLimiter = createAuthLimiter(options.rateLimitWindowMs, options.rateLimitMax)

  router.post('/register', allowedOrigin, requireJson, parseJson, registerLimiter, (request, response) => register(request, response))
  router.post('/login', allowedOrigin, requireJson, parseJson, loginLimiter, (request, response) => login(request, response, options))
  router.get('/me', requireAuthentication, (request, response) => me(request, response))
  router.post('/logout', allowedOrigin, requireJson, parseJson, (request, response) => logout(request, response, options.cookieSecure))

  return router
}
