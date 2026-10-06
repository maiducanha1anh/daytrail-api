import cors from 'cors'
import express from 'express'
import cookieParser from 'cookie-parser'
import { createAuthRouter } from './routes/auth.js'
import { createJournalRouter } from './routes/journals.js'
import { createTaskRouter } from './routes/tasks.js'
import { createImageRouter, createJournalMediaRouter, createTaskMediaRouter } from './routes/media.js'
import type { MediaStorage } from './media/storage.js'
import { isDatabaseUnavailableError, safeDatabaseFailureCode } from './database/mongoose.js'

type AppDependencies = {
  authRateLimitMax: number
  authRateLimitWindowMs: number
  cookieSecure: boolean
  frontendOrigin: string
  isDatabaseReady: () => Promise<boolean>
  mediaKeyPrefix?: string
  mediaStorage?: MediaStorage
  mediaUploadConcurrency?: number
  sessionTtlMs: number
}

export function createApp({ authRateLimitMax, authRateLimitWindowMs, cookieSecure, frontendOrigin, isDatabaseReady, mediaKeyPrefix, mediaStorage, mediaUploadConcurrency = 2, sessionTtlMs }: AppDependencies) {
  const app = express()
  app.disable('x-powered-by')
  app.use(cors({
    credentials: true,
    origin: (origin, callback) => callback(null, !origin || origin === frontendOrigin),
  }))
  app.use(cookieParser())
  app.get('/api/health', (_request, response) => response.json({ status: 'ok', service: 'daytrail-api' }))
  app.get('/api/ready', async (_request, response) => {
    const ready = await isDatabaseReady().catch(() => false)
    response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' })
  })
  app.use('/api/auth', createAuthRouter({
    cookieSecure,
    frontendOrigin,
    rateLimitMax: authRateLimitMax,
    rateLimitWindowMs: authRateLimitWindowMs,
    sessionTtlMs,
  }))
  const mediaOptions = { frontendOrigin, keyPrefix: mediaKeyPrefix, storage: mediaStorage, uploadConcurrency: mediaUploadConcurrency }
  app.use('/api/tasks', createTaskMediaRouter(mediaOptions))
  app.use('/api/journals', createJournalMediaRouter(mediaOptions))
  app.use('/api/images', createImageRouter(mediaOptions))
  app.use('/api/tasks', createTaskRouter({ frontendOrigin, mediaStorage }))
  app.use('/api/journals', createJournalRouter({ frontendOrigin, mediaStorage }))
  app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    void next
    if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
      response.status(400).json({ error: 'JSON không hợp lệ.' })
      return
    }
    if (isDatabaseUnavailableError(error)) {
      console.error(`Request failed (DatabaseUnavailable:${safeDatabaseFailureCode(error)})`)
      response.set('Retry-After', '5').status(503).json({
        code: 'DATABASE_UNAVAILABLE',
        error: 'Dữ liệu tạm thời không sẵn sàng. Vui lòng thử lại sau.',
      })
      return
    }
    console.error(`Request failed (${error instanceof Error ? error.name : 'UnknownError'})`)
    response.status(500).json({ error: 'Đã xảy ra lỗi máy chủ.' })
  })
  return app
}
