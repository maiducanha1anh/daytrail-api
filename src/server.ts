import type { Server } from 'node:http'
import { createApp } from './app.js'
import { ConfigurationError, loadConfig } from './config/env.js'
import { connectDatabase, DatabaseConnectionError, disconnectDatabase, pingDatabase } from './database/mongoose.js'

let server: Server | undefined
let shuttingDown = false

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`Received ${signal}; shutting down DayTrail API`)
  const forceExitTimer = setTimeout(() => {
    console.error('Shutdown timed out')
    process.exit(1)
  }, 10_000)
  forceExitTimer.unref()
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
  await connectDatabase(config.mongodbUri, config.mongodbConnectTimeoutMs, config.mongodbPingTimeoutMs)
  const app = createApp({
    frontendOrigin: config.frontendOrigin,
    isDatabaseReady: () => pingDatabase(config.mongodbPingTimeoutMs),
  })
  server = app.listen(config.port, () => console.log(`DayTrail API listening on http://localhost:${config.port}`))
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
