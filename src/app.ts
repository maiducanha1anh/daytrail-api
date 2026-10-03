import cors from 'cors'
import express from 'express'

type AppDependencies = {
  frontendOrigin: string
  isDatabaseReady: () => Promise<boolean>
}

export function createApp({ frontendOrigin, isDatabaseReady }: AppDependencies) {
  const app = express()
  app.use(cors({ origin: frontendOrigin }))
  app.use(express.json())
  app.get('/api/health', (_request, response) => response.json({ status: 'ok', service: 'daytrail-api' }))
  app.get('/api/ready', async (_request, response) => {
    const ready = await isDatabaseReady().catch(() => false)
    response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' })
  })
  return app
}
