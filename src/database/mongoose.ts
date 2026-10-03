import mongoose from 'mongoose'

type DatabaseConnectionOptions = {
  connectTimeoutMs: number
  databaseName: string
  pingTimeoutMs: number
  uri: string
}

export class DatabaseConnectionError extends Error {
  override name = 'DatabaseConnectionError'
}

function safeConnectionFailure(error: unknown) {
  const fallback = error instanceof Error ? error.name : 'UnknownError'
  if (!error || typeof error !== 'object') return fallback
  const directCode = 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number') ? error.code : undefined
  const codeName = 'codeName' in error && typeof error.codeName === 'string' ? error.codeName : undefined
  if (directCode !== undefined || codeName) return [codeName, directCode].filter((value) => value !== undefined).join(':')
  const reason = 'reason' in error && error.reason && typeof error.reason === 'object' ? error.reason : undefined
  const servers = reason && 'servers' in reason && reason.servers instanceof Map ? reason.servers : undefined
  if (servers) {
    for (const description of servers.values()) {
      if (!description || typeof description !== 'object' || !('error' in description)) continue
      const serverError = description.error
      if (!serverError || typeof serverError !== 'object') continue
      const code = 'code' in serverError && typeof serverError.code === 'string' ? serverError.code : undefined
      const cause = 'cause' in serverError && serverError.cause && typeof serverError.cause === 'object' ? serverError.cause : undefined
      const causeCode = cause && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined
      if (code || causeCode) return code ?? causeCode ?? fallback
    }
  }
  return fallback
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('MongoDB operation timed out')), timeoutMs)
    timer.unref()
  })
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export async function connectDatabase({ uri, databaseName, connectTimeoutMs, pingTimeoutMs }: DatabaseConnectionOptions) {
  try {
    await mongoose.connect(uri, {
      connectTimeoutMS: connectTimeoutMs,
      dbName: databaseName,
      serverSelectionTimeoutMS: connectTimeoutMs,
    })
  } catch (error: unknown) {
    throw new DatabaseConnectionError(`MongoDB connection failed (${safeConnectionFailure(error)})`)
  }
  if (mongoose.connection.name !== databaseName) {
    await mongoose.disconnect()
    throw new DatabaseConnectionError('MongoDB connected to an unexpected database')
  }
  if (!await pingDatabase(pingTimeoutMs)) {
    await mongoose.disconnect()
    throw new DatabaseConnectionError('MongoDB ping failed')
  }
  console.log(`MongoDB connected and ready (database: ${databaseName})`)
}

export async function pingDatabase(timeoutMs: number) {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) return false
  try {
    await withTimeout(mongoose.connection.db.admin().ping(), timeoutMs)
    return true
  } catch {
    return false
  }
}

export async function disconnectDatabase() {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect()
}

export function databaseConnection() {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) throw new Error('MongoDB is not connected')
  return mongoose.connection.db
}
