import { randomUUID } from 'node:crypto'
import { ConfigurationError, loadConfig } from '../config/env.js'
import { connectDatabase, databaseConnection, DatabaseConnectionError, disconnectDatabase } from '../database/mongoose.js'

const collectionName = '_connection_checks'
const documentId = `stage-1a-${randomUUID()}`

async function verify() {
  const config = loadConfig()
  await connectDatabase({
    connectTimeoutMs: config.mongodbConnectTimeoutMs,
    databaseName: config.databaseName,
    pingTimeoutMs: config.mongodbPingTimeoutMs,
    uri: config.mongodbUri,
  })
  const collection = databaseConnection().collection<{ _id: string; createdAt: Date; purpose: string }>(collectionName)
  let inserted = false
  try {
    await collection.insertOne({ _id: documentId, createdAt: new Date(), purpose: 'stage-1a-verification' })
    inserted = true
    const document = await collection.findOne({ _id: documentId })
    if (!document || document.purpose !== 'stage-1a-verification') throw new Error('MongoDB verification read failed')
  } finally {
    try {
      if (inserted) {
        const deletion = await collection.deleteOne({ _id: documentId })
        if (deletion.deletedCount !== 1) throw new Error('MongoDB verification cleanup failed')
      }
    } finally {
      await disconnectDatabase()
    }
  }
  console.log('MongoDB write/read/delete verification passed (database: daytrail)')
}

verify().catch(async (error: unknown) => {
  await disconnectDatabase().catch(() => undefined)
  const errorSummary = error instanceof DatabaseConnectionError || error instanceof ConfigurationError ? `${error.name}: ${error.message}` : error instanceof Error ? error.name : 'UnknownError'
  console.error(`MongoDB verification failed (${errorSummary})`)
  process.exitCode = 1
})
