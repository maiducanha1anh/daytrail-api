import cors from 'cors'
import express from 'express'
export function createApp() {
  const app = express()
  app.use(cors({ origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173' }))
  app.use(express.json())
  app.get('/api/health', (_request, response) => response.json({ status: 'ok', service: 'daytrail-api' }))
  return app
}
