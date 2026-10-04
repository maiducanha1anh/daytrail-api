import assert from 'node:assert/strict'
import test from 'node:test'
import mongoose from 'mongoose'
import request from 'supertest'
import { createApp } from '../app.js'
import { SESSION_COOKIE_NAME } from '../auth/session.js'

test('database outage returns 503 without treating a presented session as expired', async () => {
  await mongoose.disconnect()
  const previousBufferTimeout = mongoose.get('bufferTimeoutMS') as number
  mongoose.set('bufferTimeoutMS', 50)
  const app = createApp({
    authRateLimitMax: 10,
    authRateLimitWindowMs: 60_000,
    cookieSecure: false,
    frontendOrigin: 'http://localhost:5173',
    isDatabaseReady: async () => false,
    sessionTtlMs: 7 * 24 * 60 * 60 * 1_000,
  })

  try {
    const health = await request(app).get('/api/health')
    assert.equal(health.status, 200)
    const ready = await request(app).get('/api/ready')
    assert.equal(ready.status, 503)

    const me = await request(app)
      .get('/api/auth/me')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${'a'.repeat(43)}`)
    assert.equal(me.status, 503)
    assert.equal(me.body.code, 'DATABASE_UNAVAILABLE')
    assert.equal(me.headers['retry-after'], '5')
    assert.equal(me.headers['set-cookie'], undefined)

    const journal = await request(app)
      .get('/api/journals/2026-01-01')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${'a'.repeat(43)}`)
    assert.equal(journal.status, 503)
    assert.equal(journal.body.code, 'DATABASE_UNAVAILABLE')
    assert.equal(journal.headers['retry-after'], '5')
    assert.equal(journal.headers['set-cookie'], undefined)
  } finally {
    mongoose.set('bufferTimeoutMS', previousBufferTimeout)
  }
})
