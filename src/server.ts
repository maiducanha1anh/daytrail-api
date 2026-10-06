import type { Server } from 'node:http'
import { createApp } from './app.js'
import { ConfigurationError, loadConfig } from './config/env.js'
import { connectDatabase, DatabaseConnectionError, disconnectDatabase, pingDatabase } from './database/mongoose.js'
import { ensureDatabaseIndexes } from './models/indexes.js'
import { startMediaCleanupWorker } from './media/service.js'
import { createR2MediaStorage } from './media/storage.js'

let server: Server | undefined
let shuttingDown = false
let stopMediaCleanupWorker: (() => void) | undefined

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`Received ${signal}; shutting down DayTrail API`)
  const forceExitTimer = setTimeout(() => {
    console.error('Shutdown timed out')
    process.exit(1)
  }, 10_000)
  forceExitTimer.unref()
  stopMediaCleanupWorker?.()
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve())
    })
  }
  await disconnectDatabase()
  clearTimeout(forceExitTimer)
}

async function start() {
  const config = loadConfig()
  await connectDatabase({
    connectTimeoutMs: config.mongodbConnectTimeoutMs,
    databaseName: config.databaseName,
    pingTimeoutMs: config.mongodbPingTimeoutMs,
    uri: config.mongodbUri,
  })
  await ensureDatabaseIndexes()
  const mediaStorage = config.mediaStorage ? createR2MediaStorage(config.mediaStorage) : undefined
  const app = createApp({
    authRateLimitMax: config.authRateLimitMax,
    authRateLimitWindowMs: config.authRateLimitWindowMs,
    cookieSecure: config.cookieSecure,
    frontendOrigin: config.frontendOrigin,
    isDatabaseReady: () => pingDatabase(config.mongodbPingTimeoutMs),
    mediaKeyPrefix: config.mediaStorage?.keyPrefix,
    mediaStorage,
    mediaUploadConcurrency: config.mediaUploadConcurrency,
    sessionTtlMs: config.sessionTtlMs,
  })
  server = app.listen(config.port, () => console.log(`DayTrail API listening on http://localhost:${config.port}`))
  server.requestTimeout = 30_000
  server.headersTimeout = 35_000
  if (mediaStorage) stopMediaCleanupWorker = startMediaCleanupWorker(mediaStorage)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void shutdown(signal).then(() => process.exit(0)).catch(() => process.exit(1)))
  }
}

start().catch(async (error: unknown) => {
  await disconnectDatabase().catch(() => undefined)
  const errorSummary = error instanceof DatabaseConnectionError || error instanceof ConfigurationError ? `${error.name}: ${error.message}` : error instanceof Error ? error.name : 'UnknownError'
  console.error(`DayTrail API startup failed (${errorSummary})`)
  process.exitCode = 1
})
