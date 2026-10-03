import 'dotenv/config'

const DATABASE_NAME = 'daytrail'

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

function mongodbUri() {
  const value = required('MONGODB_URI')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ConfigurationError('MONGODB_URI is invalid')
  }
  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol)) throw new ConfigurationError('MONGODB_URI must use mongodb or mongodb+srv')
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, '').split('/')[0] ?? '')
  if (database && database !== DATABASE_NAME) throw new ConfigurationError(`MONGODB_URI must target the ${DATABASE_NAME} database`)
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
  return Object.freeze({
    databaseName: DATABASE_NAME,
    frontendOrigin: frontendOrigin(),
    mongodbConnectTimeoutMs: positiveInteger('MONGODB_CONNECT_TIMEOUT_MS', 10_000),
    mongodbPingTimeoutMs: positiveInteger('MONGODB_PING_TIMEOUT_MS', 3_000),
    mongodbUri: mongodbUri(),
    port,
  })
}
