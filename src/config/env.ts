import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { GmailApiConfig } from '../email/gmailApi.js'
import type { SmtpConfig } from '../email/sender.js'

const DEFAULT_DATABASE_NAME = 'daytrail'
const TEST_DATABASE_NAME = 'daytrail_test'
const DAY_MS = 24 * 60 * 60 * 1_000
const TEST_MEDIA_BUCKET = 'daytrail-media-test'

export type MediaStorageConfig = {
  accessKeyId: string
  bucket: string
  endpoint: string
  keyPrefix: string
  secretAccessKey: string
  timeoutMs: number
}

export class ConfigurationError extends Error {
  override name = 'ConfigurationError'
}

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new ConfigurationError(`${name} is required`)
  return value
}

function positiveInteger(name: string, fallback: number) {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new ConfigurationError(`${name} must be a positive integer`)
  return value
}

function mongodbUri(variableName: 'MONGODB_URI' | 'MONGODB_TEST_URI', databaseName: string) {
  const value = required(variableName)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ConfigurationError(`${variableName} is invalid`)
  }
  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol)) throw new ConfigurationError(`${variableName} must use mongodb or mongodb+srv`)
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, '').split('/')[0] ?? '')
  if (database !== databaseName) throw new ConfigurationError(`${variableName} must target the ${databaseName} database`)
  return value
}

function applicationDatabaseName() {
  const databaseName = process.env.MONGODB_DATABASE?.trim() || DEFAULT_DATABASE_NAME
  if (databaseName === TEST_DATABASE_NAME) throw new ConfigurationError('MONGODB_DATABASE must not target the test database')
  return databaseName
}

function frontendOrigin() {
  const value = process.env.FRONTEND_ORIGIN?.trim() || 'http://localhost:5173'
  try {
    return new URL(value).origin
  } catch {
    throw new ConfigurationError('FRONTEND_ORIGIN is invalid')
  }
}

function frontendBaseUrl(nodeEnv: string) {
  const raw = process.env.FRONTEND_BASE_URL?.trim() || frontendOrigin()
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new ConfigurationError('FRONTEND_BASE_URL is invalid')
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new ConfigurationError('FRONTEND_BASE_URL must not contain credentials, query, or hash')
  const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(nodeEnv !== 'production' && localHttp)) {
    throw new ConfigurationError('FRONTEND_BASE_URL must use https, except localhost in development or test')
  }
  return parsed.toString().replace(/\/$/, '')
}

export type EmailProviderConfig =
  | { provider: 'disabled' }
  | { provider: 'gmail_api'; gmail: GmailApiConfig }
  | { provider: 'smtp'; smtp: SmtpConfig }

type Environment = Record<string, string | undefined>

function environmentBoolean(environment: Environment, name: string, fallback: boolean) {
  const raw = environment[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new ConfigurationError(`${name} must be true or false`)
}

function environmentPositiveInteger(environment: Environment, name: string, fallback: number) {
  const raw = environment[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new ConfigurationError(`${name} must be a positive integer`)
  return value
}

function configuredSmtp(environment: Environment, nodeEnv: string): SmtpConfig {
  const host = environment.SMTP_HOST?.trim()
  const from = environment.SMTP_FROM?.trim()
  const portRaw = environment.SMTP_PORT?.trim()
  const user = environment.SMTP_USER?.trim()
  const password = environment.SMTP_PASSWORD
  if (!host || !from || !portRaw) throw new ConfigurationError('SMTP_HOST, SMTP_PORT, and SMTP_FROM are required for EMAIL_PROVIDER=smtp')
  if (Boolean(user) !== Boolean(password)) throw new ConfigurationError('SMTP_USER and SMTP_PASSWORD must be configured together')
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new ConfigurationError('SMTP_PORT must be between 1 and 65535')
  if (!/^\S+@\S+\.\S+$/.test(from)) throw new ConfigurationError('SMTP_FROM must be an email address')
  return {
    from,
    host,
    password: password || undefined,
    port,
    requireTls: environmentBoolean(environment, 'SMTP_REQUIRE_TLS', nodeEnv === 'production'),
    secure: environmentBoolean(environment, 'SMTP_SECURE', port === 465),
    timeoutMs: environmentPositiveInteger(environment, 'SMTP_TIMEOUT_MS', 10_000),
    user: user || undefined,
  }
}

function authorizedUserFromFile(path: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new ConfigurationError('GMAIL_AUTHORIZED_USER_FILE could not be read as JSON')
  }
  if (!parsed || typeof parsed !== 'object') throw new ConfigurationError('GMAIL_AUTHORIZED_USER_FILE is invalid')
  const value = parsed as Record<string, unknown>
  if (value.type !== 'authorized_user' || typeof value.client_id !== 'string' || typeof value.client_secret !== 'string' || typeof value.refresh_token !== 'string') {
    throw new ConfigurationError('GMAIL_AUTHORIZED_USER_FILE is missing authorized-user credentials')
  }
  if (typeof value.scope === 'string' && !value.scope.split(/\s+/).includes('https://www.googleapis.com/auth/gmail.send')) {
    throw new ConfigurationError('GMAIL_AUTHORIZED_USER_FILE does not include gmail.send')
  }
  return { clientId: value.client_id, clientSecret: value.client_secret, refreshToken: value.refresh_token }
}

export function loadEmailProviderConfig(nodeEnv: string, environment: Environment = process.env): EmailProviderConfig {
  const provider = environment.EMAIL_PROVIDER?.trim() || 'disabled'
  if (provider === 'disabled') return { provider }
  if (provider === 'smtp') return { provider, smtp: configuredSmtp(environment, nodeEnv) }
  if (provider !== 'gmail_api') throw new ConfigurationError('EMAIL_PROVIDER must be disabled, smtp, or gmail_api')

  const senderEmail = environment.GMAIL_SENDER_EMAIL?.trim()
  if (!senderEmail || !/^\S+@\S+\.\S+$/.test(senderEmail)) throw new ConfigurationError('GMAIL_SENDER_EMAIL must be an email address')
  const authorizedUserFile = environment.GMAIL_AUTHORIZED_USER_FILE?.trim()
  const clientId = environment.GMAIL_OAUTH_CLIENT_ID?.trim()
  const clientSecret = environment.GMAIL_OAUTH_CLIENT_SECRET
  const refreshToken = environment.GMAIL_OAUTH_REFRESH_TOKEN
  const directValues = [clientId, clientSecret, refreshToken]
  const hasDirectValue = directValues.some(Boolean)
  if (authorizedUserFile && hasDirectValue) throw new ConfigurationError('Use GMAIL_AUTHORIZED_USER_FILE or direct Gmail OAuth variables, not both')
  const credentials = authorizedUserFile
    ? authorizedUserFromFile(authorizedUserFile)
    : directValues.every(Boolean)
      ? { clientId: clientId as string, clientSecret: clientSecret as string, refreshToken: refreshToken as string }
      : undefined
  if (!credentials) throw new ConfigurationError('Gmail OAuth credentials are incomplete')
  return {
    gmail: {
      ...credentials,
      senderEmail,
      timeoutMs: environmentPositiveInteger(environment, 'GMAIL_API_TIMEOUT_MS', 10_000),
    },
    provider,
  }
}

function endpoint(variableName: string, requiredValue: boolean) {
  const raw = process.env[variableName]?.trim()
  if (!raw) {
    if (requiredValue) throw new ConfigurationError(`${variableName} is required`)
    return undefined
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new ConfigurationError(`${variableName} is invalid`)
  }
  if (parsed.protocol !== 'https:') throw new ConfigurationError(`${variableName} must use https`)
  return parsed.origin
}

function optionalMediaStorageConfig(): MediaStorageConfig | undefined {
  const names = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const
  const values = names.map((name) => process.env[name]?.trim())
  if (values.every((value) => !value)) return undefined
  if (values.some((value) => !value)) return undefined
  return {
    accessKeyId: values[1] as string,
    bucket: values[3] as string,
    endpoint: endpoint('R2_ENDPOINT', true) as string,
    keyPrefix: 'daytrail/dev',
    secretAccessKey: values[2] as string,
    timeoutMs: positiveInteger('R2_TIMEOUT_MS', 20_000),
  }
}

export function loadTestMediaConfig(keySuffix: string): MediaStorageConfig {
  const bucket = required('R2_TEST_BUCKET')
  if (bucket !== TEST_MEDIA_BUCKET) throw new ConfigurationError(`R2_TEST_BUCKET must be ${TEST_MEDIA_BUCKET}`)
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(keySuffix)) throw new ConfigurationError('Test media key suffix is invalid')
  return Object.freeze({
    accessKeyId: required('R2_TEST_ACCESS_KEY_ID'),
    bucket,
    endpoint: endpoint('R2_TEST_ENDPOINT', true) as string,
    keyPrefix: `daytrail/test/${keySuffix}`,
    secretAccessKey: required('R2_TEST_SECRET_ACCESS_KEY'),
    timeoutMs: positiveInteger('R2_TIMEOUT_MS', 20_000),
  })
}

export function loadConfig() {
  const port = positiveInteger('PORT', 4000)
  if (port > 65_535) throw new ConfigurationError('PORT must be at most 65535')
  const nodeEnv = process.env.NODE_ENV?.trim() || 'development'
  if (!['development', 'production', 'test'].includes(nodeEnv)) throw new ConfigurationError('NODE_ENV must be development, production, or test')
  const databaseName = applicationDatabaseName()
  return Object.freeze({
    authRateLimitMax: positiveInteger('AUTH_RATE_LIMIT_MAX', 10),
    authRateLimitWindowMs: positiveInteger('AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1_000),
    cookieSecure: nodeEnv === 'production',
    databaseName,
    emailCooldownMs: positiveInteger('EMAIL_COOLDOWN_SECONDS', 60) * 1_000,
    emailProvider: loadEmailProviderConfig(nodeEnv),
    frontendBaseUrl: frontendBaseUrl(nodeEnv),
    frontendDistDir: nodeEnv === 'production'
      ? resolve(process.env.FRONTEND_DIST_DIR?.trim() || 'render-frontend-dist')
      : undefined,
    frontendOrigin: frontendOrigin(),
    httpRequestTimeoutMs: positiveInteger('HTTP_REQUEST_TIMEOUT_MS', 30_000),
    mongodbConnectTimeoutMs: positiveInteger('MONGODB_CONNECT_TIMEOUT_MS', 10_000),
    mongodbPingTimeoutMs: positiveInteger('MONGODB_PING_TIMEOUT_MS', 3_000),
    mongodbUri: mongodbUri('MONGODB_URI', databaseName),
    mediaStorage: optionalMediaStorageConfig(),
    mediaUploadConcurrency: positiveInteger('MEDIA_UPLOAD_CONCURRENCY', 2),
    nodeEnv,
    port,
    sessionTtlMs: positiveInteger('SESSION_TTL_DAYS', 7) * DAY_MS,
    trustProxy: nodeEnv === 'production' ? 1 : false,
  })
}

export function loadTestConfig() {
  return Object.freeze({
    databaseName: TEST_DATABASE_NAME,
    frontendOrigin: frontendOrigin(),
    mongodbConnectTimeoutMs: positiveInteger('MONGODB_CONNECT_TIMEOUT_MS', 10_000),
    mongodbPingTimeoutMs: positiveInteger('MONGODB_PING_TIMEOUT_MS', 3_000),
    mongodbUri: mongodbUri('MONGODB_TEST_URI', TEST_DATABASE_NAME),
  })
}
