import 'dotenv/config'

const DATABASE_NAME = 'daytrail'
const TEST_DATABASE_NAME = 'daytrail_test'
const DAY_MS = 24 * 60 * 60 * 1_000

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

function frontendOrigin() {
  const value = process.env.FRONTEND_ORIGIN?.trim() || 'http://localhost:5173'
  try {
    return new URL(value).origin
  } catch {
    throw new ConfigurationError('FRONTEND_ORIGIN is invalid')
  }
}

export function loadConfig() {
  const port = positiveInteger('PORT', 4000)
  if (port > 65_535) throw new ConfigurationError('PORT must be at most 65535')
  const nodeEnv = process.env.NODE_ENV?.trim() || 'development'
  if (!['development', 'production', 'test'].includes(nodeEnv)) throw new ConfigurationError('NODE_ENV must be development, production, or test')
  return Object.freeze({
    authRateLimitMax: positiveInteger('AUTH_RATE_LIMIT_MAX', 10),
    authRateLimitWindowMs: positiveInteger('AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1_000),
    cookieSecure: nodeEnv === 'production',
    databaseName: DATABASE_NAME,
    frontendOrigin: frontendOrigin(),
    mongodbConnectTimeoutMs: positiveInteger('MONGODB_CONNECT_TIMEOUT_MS', 10_000),
    mongodbPingTimeoutMs: positiveInteger('MONGODB_PING_TIMEOUT_MS', 3_000),
    mongodbUri: mongodbUri('MONGODB_URI', DATABASE_NAME),
    nodeEnv,
    port,
    sessionTtlMs: positiveInteger('SESSION_TTL_DAYS', 7) * DAY_MS,
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
