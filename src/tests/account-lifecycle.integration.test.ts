import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import type { Express } from 'express'
import mongoose from 'mongoose'
import request from 'supertest'
import { hashPassword } from '../auth/password.js'
import { createSession, SESSION_COOKIE_NAME } from '../auth/session.js'
import { createApp } from '../app.js'
import { loadTestConfig } from '../config/env.js'
import { connectDatabase, disconnectDatabase, pingDatabase } from '../database/mongoose.js'
import type { EmailMessage, EmailSender } from '../email/sender.js'
import { AccountToken } from '../models/AccountToken.js'
import { ensureDatabaseIndexes } from '../models/indexes.js'
import { Session } from '../models/Session.js'
import { User } from '../models/User.js'

const frontendOrigin = 'http://localhost:5173'
const runId = randomUUID().replaceAll('-', '')
const testDomain = `${runId}.account.test`
const originalPassword = 'MatKhauBanDau!123'
const replacementPassword = 'MatKhauMoiRatManh!456'
let app: Express

class CaptureEmailSender implements EmailSender {
  messages: EmailMessage[] = []
  failNext = false

  async send(message: EmailMessage) {
    if (this.failNext) {
      this.failNext = false
      const error = new Error('Synthetic SMTP failure')
      error.name = 'SyntheticSmtpError'
      throw error
    }
    this.messages.push(message)
  }

  take(subject: string, to: string) {
    let index = -1
    for (let candidate = this.messages.length - 1; candidate >= 0; candidate -= 1) {
      const message = this.messages[candidate]
      if (message?.subject === subject && message.to === to) {
        index = candidate
        break
      }
    }
    assert.notEqual(index, -1, `Missing captured email ${subject}`)
    return this.messages.splice(index, 1)[0] as EmailMessage
  }
}

const emailSender = new CaptureEmailSender()

function email(label: string) {
  return `${label}@${testDomain}`
}

function createTestApp(sender: EmailSender = emailSender, cooldownMs = 60_000) {
  return createApp({
    authRateLimitMax: 100,
    authRateLimitWindowMs: 60_000,
    cookieSecure: false,
    emailCooldownMs: cooldownMs,
    emailSender: sender,
    frontendBaseUrl: frontendOrigin,
    frontendOrigin,
    isDatabaseReady: () => pingDatabase(3_000),
    sessionTtlMs: 7 * 24 * 60 * 60 * 1_000,
  })
}

function cookiePair(response: request.Response) {
  const header = response.headers['set-cookie']
  const cookie = Array.isArray(header) ? header[0] : header
  assert.equal(typeof cookie, 'string')
  return cookie.split(';', 1)[0] as string
}

function tokenFrom(message: EmailMessage, route: 'reset-password' | 'verify-email') {
  const match = message.text.match(new RegExp(`#${route}\\?token=([A-Za-z0-9_-]{43})`))
  assert.ok(match)
  return match[1] as string
}

async function register(userEmail: string, displayName = 'Người dùng kiểm thử') {
  return request(app)
    .post('/api/auth/register')
    .set('Origin', frontendOrigin)
    .send({ displayName, email: userEmail, password: originalPassword })
}

async function login(userEmail: string, password = originalPassword) {
  return request(app).post('/api/auth/login').set('Origin', frontendOrigin).send({ email: userEmail, password })
}

before(async () => {
  const config = loadTestConfig()
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
  await AccountToken.deleteMany({ userId: { $in: userIds } })
  await Session.deleteMany({ userId: { $in: userIds } })
  await User.deleteMany({ _id: { $in: userIds } })
  assert.equal(await AccountToken.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await Session.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await User.countDocuments({ _id: { $in: userIds } }), 0)
  emailSender.messages.length = 0
  await disconnectDatabase()
})

describe('DayTrail account lifecycle integration', { concurrency: 1 }, () => {
  test('password reset request is neutral for existing, missing, and SMTP failure cases', async () => {
    const existingEmail = email('neutral-existing')
    assert.equal((await register(existingEmail)).status, 201)
    emailSender.take('Xác minh email DayTrail', existingEmail)
    const existing = await request(app).post('/api/auth/password-reset/request').set('Origin', frontendOrigin).send({ email: existingEmail })
    const missing = await request(app).post('/api/auth/password-reset/request').set('Origin', frontendOrigin).send({ email: email('neutral-missing') })
    emailSender.take('Đặt lại mật khẩu DayTrail', existingEmail)
    const smtpFailureEmail = email('neutral-smtp')
    assert.equal((await register(smtpFailureEmail)).status, 201)
    emailSender.take('Xác minh email DayTrail', smtpFailureEmail)
    emailSender.failNext = true
    const failedDelivery = await request(app).post('/api/auth/password-reset/request').set('Origin', frontendOrigin).send({ email: smtpFailureEmail })
    assert.equal(existing.status, 202)
    assert.equal(missing.status, 202)
    assert.equal(failedDelivery.status, 202)
    assert.deepEqual(existing.body, missing.body)
    assert.deepEqual(existing.body, failedDelivery.body)
    assert.doesNotMatch(JSON.stringify(existing.body), /token|exists|sent/i)
  })

  test('email target cooldown and wrong Origin are enforced without account disclosure', async () => {
    const cooldownApp = createTestApp(emailSender, 60_000)
    const target = email('cooldown-missing')
    const first = await request(cooldownApp).post('/api/auth/password-reset/request').set('Origin', frontendOrigin).send({ email: target })
    const second = await request(cooldownApp).post('/api/auth/password-reset/request').set('Origin', frontendOrigin).send({ email: target })
    assert.equal(first.status, 202)
    assert.equal(second.status, 429)
    const wrongOrigin = await request(app).post('/api/auth/password-reset/request').set('Origin', 'https://wrong.example').send({ email: target })
    assert.equal(wrongOrigin.status, 403)
  })

  test('reset rejects invalid, expired, used, and verification-purpose tokens', async () => {
    const target = email('reset-invalid')
    assert.equal((await register(target)).status, 201)
    const verificationToken = tokenFrom(emailSender.take('Xác minh email DayTrail', target), 'verify-email')
    const wrongPurpose = await request(app).post('/api/auth/password-reset/confirm').set('Origin', frontendOrigin).send({ token: verificationToken, newPassword: replacementPassword })
    assert.equal(wrongPurpose.status, 400)

    assert.equal((await request(app).post('/api/auth/password-reset/request').set('Origin', frontendOrigin).send({ email: target })).status, 202)
    const expiredToken = tokenFrom(emailSender.take('Đặt lại mật khẩu DayTrail', target), 'reset-password')
    await AccountToken.updateOne({ purpose: 'password_reset', email: target }, { $set: { expiresAt: new Date(Date.now() - 1_000) } })
    const expired = await request(app).post('/api/auth/password-reset/confirm').set('Origin', frontendOrigin).send({ token: expiredToken, newPassword: replacementPassword })
    assert.equal(expired.status, 400)
    assert.equal(expired.body.code, 'TOKEN_INVALID_OR_EXPIRED')
    assert.equal((await request(app).post('/api/auth/password-reset/confirm').set('Origin', frontendOrigin).send({ token: 'x'.repeat(43), newPassword: replacementPassword })).status, 400)
  })

  test('one reset token can be consumed by only one concurrent request', async () => {
    const target = email('reset-race')
    assert.equal((await register(target)).status, 201)
    emailSender.take('Xác minh email DayTrail', target)
    await request(app).post('/api/auth/password-reset/request').set('Origin', frontendOrigin).send({ email: target })
    const token = tokenFrom(emailSender.take('Đặt lại mật khẩu DayTrail', target), 'reset-password')
    const results = await Promise.all([
      request(app).post('/api/auth/password-reset/confirm').set('Origin', frontendOrigin).send({ token, newPassword: replacementPassword }),
      request(app).post('/api/auth/password-reset/confirm').set('Origin', frontendOrigin).send({ token, newPassword: replacementPassword }),
    ])
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 400])
    emailSender.take('Mật khẩu DayTrail đã thay đổi', target)
  })

  test('successful reset revokes sessions, keeps email unverified, and changes credentials', async () => {
    const target = email('reset-success')
    assert.equal((await register(target)).status, 201)
    emailSender.take('Xác minh email DayTrail', target)
    const oldSession = cookiePair(await login(target))
    await request(app).post('/api/auth/password-reset/request').set('Origin', frontendOrigin).send({ email: target })
    const token = tokenFrom(emailSender.take('Đặt lại mật khẩu DayTrail', target), 'reset-password')
    emailSender.failNext = true
    const reset = await request(app).post('/api/auth/password-reset/confirm').set('Origin', frontendOrigin).send({ token, newPassword: replacementPassword })
    assert.equal(reset.status, 200)
    assert.equal(reset.body.notificationEmailSent, false)
    assert.equal((await request(app).get('/api/auth/me').set('Cookie', oldSession)).status, 401)
    assert.equal((await login(target, originalPassword)).status, 401)
    assert.equal((await login(target, replacementPassword)).status, 200)
    assert.equal((await User.findOne({ email: target }))?.emailVerifiedAt, undefined)
    assert.equal((await request(app).post('/api/auth/password-reset/confirm').set('Origin', frontendOrigin).send({ token, newPassword: originalPassword })).status, 400)
  })

  test('change password verifies the current password and revokes all sessions', async () => {
    const target = email('change-password')
    assert.equal((await register(target)).status, 201)
    emailSender.take('Xác minh email DayTrail', target)
    const firstSession = cookiePair(await login(target))
    const secondSession = cookiePair(await login(target))
    const wrong = await request(app).post('/api/auth/password/change').set('Origin', frontendOrigin).set('Cookie', firstSession).send({ currentPassword: 'SaiMatKhau!123', newPassword: replacementPassword })
    assert.equal(wrong.status, 400)
    assert.equal((await login(target, originalPassword)).status, 200)
    const changed = await request(app).post('/api/auth/password/change').set('Origin', frontendOrigin).set('Cookie', firstSession).send({ currentPassword: originalPassword, newPassword: replacementPassword })
    assert.equal(changed.status, 200)
    emailSender.take('Mật khẩu DayTrail đã thay đổi', target)
    assert.equal((await request(app).get('/api/auth/me').set('Cookie', firstSession)).status, 401)
    assert.equal((await request(app).get('/api/auth/me').set('Cookie', secondSession)).status, 401)
    assert.equal((await login(target, originalPassword)).status, 401)
    assert.equal((await login(target, replacementPassword)).status, 200)
  })

  test('a late session using the old credential version is never valid', async () => {
    const target = email('login-race')
    assert.equal((await register(target)).status, 201)
    emailSender.take('Xác minh email DayTrail', target)
    const user = await User.findOne({ email: target })
    assert.ok(user)
    const activeCookie = cookiePair(await login(target))
    const change = await request(app).post('/api/auth/password/change').set('Origin', frontendOrigin).set('Cookie', activeCookie).send({ currentPassword: originalPassword, newPassword: replacementPassword })
    assert.equal(change.status, 200)
    emailSender.take('Mật khẩu DayTrail đã thay đổi', target)
    const stale = await createSession(user._id, 60_000, 0)
    const staleCookie = `${SESSION_COOKIE_NAME}=${stale.token}`
    assert.equal((await request(app).get('/api/auth/me').set('Cookie', staleCookie)).status, 401)
    assert.equal(await Session.exists({ _id: stale.session._id }), null)
  })

  test('verification requires POST confirmation, affects only the target, and does not log in', async () => {
    const target = email('verify-target')
    const other = email('verify-other')
    assert.equal((await register(target)).status, 201)
    const token = tokenFrom(emailSender.take('Xác minh email DayTrail', target), 'verify-email')
    assert.equal((await register(other)).status, 201)
    emailSender.take('Xác minh email DayTrail', other)
    const otherCookie = cookiePair(await login(other))
    assert.equal((await request(app).get(`/api/auth/email-verification/confirm?token=${token}`)).status, 404)
    const confirmed = await request(app).post('/api/auth/email-verification/confirm').set('Origin', frontendOrigin).set('Cookie', otherCookie).send({ token })
    assert.equal(confirmed.status, 200)
    assert.equal(confirmed.headers['set-cookie'], undefined)
    const targetUser = await User.findOne({ email: target })
    const otherUser = await User.findOne({ email: other })
    assert.ok(targetUser?.emailVerifiedAt)
    assert.equal(otherUser?.emailVerifiedAt, undefined)
    const otherMe = await request(app).get('/api/auth/me').set('Cookie', otherCookie)
    assert.equal(otherMe.body.user.email, other)
  })

  test('failed resend keeps the previously delivered verification token usable', async () => {
    const target = email('resend-failure')
    assert.equal((await register(target)).status, 201)
    const originalToken = tokenFrom(emailSender.take('Xác minh email DayTrail', target), 'verify-email')
    const cookie = cookiePair(await login(target))
    emailSender.failNext = true
    const resend = await request(app).post('/api/auth/email-verification/resend').set('Origin', frontendOrigin).set('Cookie', cookie).send({})
    assert.equal(resend.status, 503)
    const confirmed = await request(app).post('/api/auth/email-verification/confirm').set('Origin', frontendOrigin).send({ token: originalToken })
    assert.equal(confirmed.status, 200)
  })

  test('legacy users without lifecycle fields can still log in and keep their identity', async () => {
    const target = email('legacy')
    const inserted = await User.collection.insertOne({
      createdAt: new Date(),
      displayName: 'Tài khoản cũ',
      email: target,
      passwordHash: await hashPassword(originalPassword),
      updatedAt: new Date(),
    })
    const response = await login(target)
    assert.equal(response.status, 200)
    assert.equal(response.body.user.id, inserted.insertedId.toString())
    assert.equal(response.body.user.displayName, 'Tài khoản cũ')
    assert.equal(response.body.user.email, target)
    assert.equal(response.body.user.emailVerifiedAt, null)
    assert.doesNotMatch(JSON.stringify(response.body), /passwordHash|tokenHash/i)
  })
})
