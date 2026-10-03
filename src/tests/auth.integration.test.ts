import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import type { Express } from 'express'
import mongoose from 'mongoose'
import request from 'supertest'
import { passwordValidationError, verifyPassword } from '../auth/password.js'
import { hashSessionToken, SESSION_COOKIE_NAME } from '../auth/session.js'
import { createApp } from '../app.js'
import { loadTestConfig } from '../config/env.js'
import { connectDatabase, disconnectDatabase, pingDatabase } from '../database/mongoose.js'
import { ensureDatabaseIndexes } from '../models/indexes.js'
import { Session } from '../models/Session.js'
import { User } from '../models/User.js'

const frontendOrigin = 'http://localhost:5173'
const runId = randomUUID().replaceAll('-', '')
const testDomain = `${runId}.stage1b.test`
const validPassword = 'MatKhauRatManh!123'
let app: Express
let pingTimeoutMs = 3_000

function email(label: string) {
  return `${label}@${testDomain}`
}

function createTestApp(rateLimitMax = 100, cookieSecure = false) {
  return createApp({
    authRateLimitMax: rateLimitMax,
    authRateLimitWindowMs: 60_000,
    cookieSecure,
    frontendOrigin,
    isDatabaseReady: () => pingDatabase(pingTimeoutMs),
    sessionTtlMs: 7 * 24 * 60 * 60 * 1_000,
  })
}

function cookieFrom(response: request.Response) {
  const header = response.headers['set-cookie']
  const value = Array.isArray(header) ? header[0] : header
  assert.equal(typeof value, 'string')
  return value
}

function cookiePair(cookie: string) {
  return cookie.split(';', 1)[0] ?? ''
}

function cookieToken(cookie: string) {
  const pair = cookiePair(cookie)
  const prefix = `${SESSION_COOKIE_NAME}=`
  assert.ok(pair.startsWith(prefix))
  return pair.slice(prefix.length)
}

async function register(targetApp: Express, userEmail: string, displayName = 'Nguoi dung thu nghiem') {
  return request(targetApp)
    .post('/api/auth/register')
    .set('Origin', frontendOrigin)
    .send({ displayName, email: userEmail, password: validPassword })
}

before(async () => {
  const config = loadTestConfig()
  pingTimeoutMs = config.mongodbPingTimeoutMs
  await connectDatabase({
    connectTimeoutMs: config.mongodbConnectTimeoutMs,
    databaseName: config.databaseName,
    pingTimeoutMs: config.mongodbPingTimeoutMs,
    uri: config.mongodbUri,
  })
  assert.equal(mongoose.connection.name, 'daytrail_test')
  await ensureDatabaseIndexes()
  app = createTestApp()
})

after(async () => {
  if (mongoose.connection.readyState !== 1) return
  assert.equal(mongoose.connection.name, 'daytrail_test')
  const users = await User.find({ email: { $regex: `@${testDomain.replaceAll('.', '\\.')}$` } }).select('_id')
  const userIds = users.map((user) => user._id)
  if (userIds.length) {
    await Session.deleteMany({ userId: { $in: userIds } })
    await User.deleteMany({ _id: { $in: userIds } })
  }
  await disconnectDatabase()
})

describe('DayTrail auth integration', { concurrency: 1 }, () => {
  test('health, readiness and credentialed CORS remain available', async () => {
    const health = await request(app).get('/api/health').set('Origin', frontendOrigin)
    assert.equal(health.status, 200)
    assert.deepEqual(health.body, { service: 'daytrail-api', status: 'ok' })
    assert.equal(health.headers['access-control-allow-origin'], frontendOrigin)
    assert.equal(health.headers['access-control-allow-credentials'], 'true')
    const ready = await request(app).get('/api/ready')
    assert.equal(ready.status, 200)
    assert.deepEqual(ready.body, { status: 'ready' })
    const sessionIndexes = await Session.collection.indexes()
    const ttlIndex = sessionIndexes.find((index) => index.name === 'expired_sessions_ttl')
    assert.equal(ttlIndex?.expireAfterSeconds, 0)
  })

  test('register validates input, normalizes email, hashes password and does not log in', async () => {
    const primaryEmail = email('primary')
    const response = await request(app)
      .post('/api/auth/register')
      .set('Origin', frontendOrigin)
      .send({ displayName: '  Người dùng chính  ', email: `  ${primaryEmail.toUpperCase()}  `, password: validPassword })
    assert.equal(response.status, 201)
    assert.equal(response.body.user.email, primaryEmail)
    assert.equal(response.body.user.displayName, 'Người dùng chính')
    assert.equal(response.headers['set-cookie'], undefined)
    assert.doesNotMatch(JSON.stringify(response.body), /password|token/i)

    const stored = await User.findOne({ email: primaryEmail }).select('+passwordHash')
    assert.ok(stored)
    assert.notEqual(stored.passwordHash, validPassword)
    assert.equal(await verifyPassword(validPassword, stored.passwordHash), true)

    const shortPassword = await request(app)
      .post('/api/auth/register')
      .set('Origin', frontendOrigin)
      .send({ displayName: 'Sai', email: email('short'), password: 'ngan' })
    assert.equal(shortPassword.status, 400)

    const oversizedPassword = await request(app)
      .post('/api/auth/register')
      .set('Origin', frontendOrigin)
      .send({ displayName: 'Sai', email: email('oversized'), password: 'á'.repeat(40) })
    assert.equal(oversizedPassword.status, 400)
    assert.match(passwordValidationError('á'.repeat(40)) ?? '', /72/)
  })

  test('duplicate normalized email is rejected, including concurrent requests', async () => {
    const duplicateEmail = email('duplicate')
    assert.equal((await register(app, duplicateEmail)).status, 201)
    assert.equal((await register(app, `  ${duplicateEmail.toUpperCase()}  `)).status, 409)

    const raceEmail = email('race')
    const results = await Promise.all([register(app, raceEmail), register(app, raceEmail.toUpperCase())])
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409])
  })

  test('login uses one generic failure and creates only a hashed session token', async () => {
    const primaryEmail = email('primary')
    const wrongEmail = await request(app).post('/api/auth/login').set('Origin', frontendOrigin).send({ email: email('missing'), password: validPassword })
    const wrongPassword = await request(app).post('/api/auth/login').set('Origin', frontendOrigin).send({ email: primaryEmail, password: 'SaiMatKhau!123' })
    assert.equal(wrongEmail.status, 401)
    assert.equal(wrongPassword.status, 401)
    assert.equal(wrongEmail.body.error, wrongPassword.body.error)

    const login = await request(app).post('/api/auth/login').set('Origin', frontendOrigin).send({ email: primaryEmail, password: validPassword })
    assert.equal(login.status, 200)
    const cookie = cookieFrom(login)
    assert.match(cookie, /HttpOnly/i)
    assert.match(cookie, /SameSite=Lax/i)
    assert.match(cookie, /Path=\//i)
    assert.match(cookie, /Max-Age=604800/i)
    assert.doesNotMatch(cookie, /;\s*Secure/i)
    assert.doesNotMatch(JSON.stringify(login.body), /password|token/i)

    const token = cookieToken(cookie)
    const session = await Session.findOne({ tokenHash: hashSessionToken(token) })
    assert.ok(session)
    assert.notEqual(session.tokenHash, token)

    const secureLogin = await request(createTestApp(100, true)).post('/api/auth/login').set('Origin', frontendOrigin).send({ email: primaryEmail, password: validPassword })
    assert.match(cookieFrom(secureLogin), /;\s*Secure/i)
  })

  test('/me rejects missing and expired sessions and accepts a valid session', async () => {
    assert.equal((await request(app).get('/api/auth/me')).status, 401)
    const primaryEmail = email('primary')
    const login = await request(app).post('/api/auth/login').set('Origin', frontendOrigin).send({ email: primaryEmail, password: validPassword })
    const cookie = cookiePair(cookieFrom(login))
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie)
    assert.equal(me.status, 200)
    assert.equal(me.body.user.email, primaryEmail)
    const afterAppRestart = await request(createTestApp()).get('/api/auth/me').set('Cookie', cookie)
    assert.equal(afterAppRestart.status, 200)

    const tokenHash = hashSessionToken(cookieToken(cookie))
    await Session.updateOne({ tokenHash }, { $set: { expiresAt: new Date(Date.now() - 1_000) } })
    assert.equal((await request(app).get('/api/auth/me').set('Cookie', cookie)).status, 401)
    assert.equal(await Session.countDocuments({ tokenHash }), 0)
  })

  test('logout revokes the current token and remains idempotent', async () => {
    const primaryEmail = email('primary')
    const login = await request(app).post('/api/auth/login').set('Origin', frontendOrigin).send({ email: primaryEmail, password: validPassword })
    const cookie = cookiePair(cookieFrom(login))
    const logout = await request(app).post('/api/auth/logout').set('Origin', frontendOrigin).set('Cookie', cookie).send({})
    assert.equal(logout.status, 204)
    assert.match(cookieFrom(logout), /Expires=Thu, 01 Jan 1970/i)
    assert.equal((await request(app).get('/api/auth/me').set('Cookie', cookie)).status, 401)
    assert.equal((await request(app).post('/api/auth/logout').set('Origin', frontendOrigin).set('Cookie', cookie).send({})).status, 204)
  })

  test('CSRF origin and JSON checks reject browser misuse while no-Origin API clients are allowed', async () => {
    const rejectedEmail = email('wrong-origin')
    const wrongOrigin = await request(app)
      .post('/api/auth/register')
      .set('Origin', 'https://example.invalid')
      .send({ displayName: 'Sai origin', email: rejectedEmail, password: validPassword })
    assert.equal(wrongOrigin.status, 403)
    assert.equal(await User.countDocuments({ email: rejectedEmail }), 0)

    const wrongType = await request(app)
      .post('/api/auth/register')
      .set('Origin', frontendOrigin)
      .type('form')
      .send({ displayName: 'Sai content type', email: email('wrong-type'), password: validPassword })
    assert.equal(wrongType.status, 415)

    const noOrigin = await request(app)
      .post('/api/auth/register')
      .send({ displayName: 'API client', email: email('no-origin'), password: validPassword })
    assert.equal(noOrigin.status, 201)
  })

  test('register and login rate limiting returns 429', async () => {
    const limitedLoginApp = createTestApp(2)
    const loginStatuses: number[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await request(limitedLoginApp)
        .post('/api/auth/login')
        .set('Origin', frontendOrigin)
        .send({ email: email('rate-limit'), password: validPassword })
      loginStatuses.push(response.status)
    }
    assert.deepEqual(loginStatuses, [401, 401, 429])

    const limitedRegisterApp = createTestApp(2)
    const registerStatuses: number[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await request(limitedRegisterApp)
        .post('/api/auth/register')
        .set('Origin', frontendOrigin)
        .send({ displayName: 'Rate limit', email: email(`register-rate-${attempt}`), password: 'ngan' })
      registerStatuses.push(response.status)
    }
    assert.deepEqual(registerStatuses, [400, 400, 429])
  })
})
