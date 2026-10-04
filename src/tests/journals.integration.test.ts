import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import type { Express } from 'express'
import mongoose from 'mongoose'
import request from 'supertest'
import { createApp } from '../app.js'
import { loadTestConfig } from '../config/env.js'
import { connectDatabase, disconnectDatabase, pingDatabase } from '../database/mongoose.js'
import { Journal } from '../models/Journal.js'
import { ensureDatabaseIndexes } from '../models/indexes.js'
import { Session } from '../models/Session.js'
import { Task } from '../models/Task.js'
import { TaskSeries } from '../models/TaskSeries.js'
import { User } from '../models/User.js'

const frontendOrigin = 'http://localhost:5173'
const runId = randomUUID().replaceAll('-', '')
const testDomain = `${runId}.stage4a.test`
const validPassword = 'MatKhauNhatKy!123'
const primaryEmail = `primary@${testDomain}`
const secondaryEmail = `secondary@${testDomain}`
let app: Express
let pingTimeoutMs = 3_000
let primaryAgent: ReturnType<typeof request.agent>
let secondaryAgent: ReturnType<typeof request.agent>
let primaryUserId = ''

function createTestApp() {
  return createApp({
    authRateLimitMax: 100,
    authRateLimitWindowMs: 60_000,
    cookieSecure: false,
    frontendOrigin,
    isDatabaseReady: () => pingDatabase(pingTimeoutMs),
    sessionTtlMs: 7 * 24 * 60 * 60 * 1_000,
  })
}

async function registerAndLogin(agent: ReturnType<typeof request.agent>, email: string, displayName: string) {
  const registration = await agent.post('/api/auth/register').set('Origin', frontendOrigin).send({ displayName, email, password: validPassword })
  assert.equal(registration.status, 201)
  const login = await agent.post('/api/auth/login').set('Origin', frontendOrigin).send({ email, password: validPassword })
  assert.equal(login.status, 200)
  return registration.body.user.id as string
}

function saveJournal(agent: ReturnType<typeof request.agent>, date: string, content: unknown, version: unknown) {
  return agent.put(`/api/journals/${date}`).set('Origin', frontendOrigin).send({ content, version })
}

function deleteJournal(agent: ReturnType<typeof request.agent>, date: string, version: unknown) {
  return agent.delete(`/api/journals/${date}`).set('Origin', frontendOrigin).send({ version })
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
  primaryAgent = request.agent(app)
  secondaryAgent = request.agent(app)
  primaryUserId = await registerAndLogin(primaryAgent, primaryEmail, 'Người viết nhật ký')
  await registerAndLogin(secondaryAgent, secondaryEmail, 'Người viết thứ hai')
})

after(async () => {
  if (mongoose.connection.readyState !== 1) return
  assert.equal(mongoose.connection.name, 'daytrail_test')
  const users = await User.find({ email: { $regex: `@${testDomain.replaceAll('.', '\\.')}$` } }).select('_id')
  const userIds = users.map((user) => user._id)
  if (userIds.length > 0) {
    await Journal.deleteMany({ userId: { $in: userIds } })
    await Task.deleteMany({ userId: { $in: userIds } })
    await TaskSeries.deleteMany({ userId: { $in: userIds } })
    await Session.deleteMany({ userId: { $in: userIds } })
    await User.deleteMany({ _id: { $in: userIds } })
  }
  assert.equal(await Journal.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await Task.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await TaskSeries.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await Session.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await User.countDocuments({ _id: { $in: userIds } }), 0)
  await disconnectDatabase()
})

describe('DayTrail journal integration', { concurrency: 1 }, () => {
  test('routes require a session and writes enforce Origin and JSON', async () => {
    const date = '2026-01-10'
    assert.equal((await request(app).get(`/api/journals/${date}`)).status, 401)
    assert.equal((await request(app).get(`/api/journals?from=${date}&to=${date}`)).status, 401)
    assert.equal((await request(app).put(`/api/journals/${date}`).set('Origin', frontendOrigin).send({ content: 'Không hợp lệ', version: null })).status, 401)
    assert.equal((await primaryAgent.put(`/api/journals/${date}`).set('Origin', 'https://example.invalid').send({ content: 'Sai origin', version: null })).status, 403)
    assert.equal((await primaryAgent.put(`/api/journals/${date}`).set('Origin', frontendOrigin).type('form').send({ content: 'Sai kiểu', version: null })).status, 415)
    assert.equal((await primaryAgent.delete(`/api/journals/${date}`).set('Origin', 'https://example.invalid').send({ version: 1 })).status, 403)

    const empty = await primaryAgent.get(`/api/journals/${date}`)
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body, { journal: null })
    const indexes = await Journal.collection.indexes()
    const unique = indexes.find((index) => index.name === 'unique_journal_user_date')
    assert.equal(unique?.unique, true)
    assert.equal(unique?.key.userId, 1)
    assert.equal(unique?.key.date, 1)
  })

  test('create and read preserve Vietnamese, newlines and surrounding whitespace without tasks', async () => {
    const date = '2026-02-01'
    const content = '  Hôm nay mình bắt đầu tốt.\n\n  Giữ nguyên khoảng trắng này.  '
    assert.equal(await Task.countDocuments({ userId: primaryUserId, date }), 0)
    const created = await saveJournal(primaryAgent, date, content, null)
    assert.equal(created.status, 201)
    assert.equal(created.body.journal.content, content)
    assert.equal(created.body.journal.date, date)
    assert.equal(created.body.journal.version, 1)
    assert.equal('userId' in created.body.journal, false)

    const read = await primaryAgent.get(`/api/journals/${date}`)
    assert.equal(read.status, 200)
    assert.equal(read.body.journal.content, content)
    assert.equal(read.body.journal.version, 1)
    assert.equal(await Task.countDocuments({ userId: primaryUserId, date }), 0)
  })

  test('validation rejects invalid dates, content, versions and protected fields', async () => {
    assert.equal((await primaryAgent.get('/api/journals/2025-02-29')).status, 400)
    assert.equal((await saveJournal(primaryAgent, '2026-02-30', 'Sai ngày', null)).status, 400)
    assert.equal((await saveJournal(primaryAgent, '2026-02-02', '   \n\t ', null)).status, 400)
    assert.equal((await saveJournal(primaryAgent, '2026-02-02', 42, null)).status, 400)
    assert.equal((await saveJournal(primaryAgent, '2026-02-02', 'x'.repeat(20_001), null)).status, 400)
    assert.equal((await primaryAgent.put('/api/journals/2026-02-02').set('Origin', frontendOrigin).send({ content: 'Thiếu version' })).status, 400)
    assert.equal((await saveJournal(primaryAgent, '2026-02-02', 'Sai version', 0)).status, 400)
    assert.equal((await primaryAgent.put('/api/journals/2026-02-02').set('Origin', frontendOrigin).send({ content: 'Không đổi chủ', version: null, userId: primaryUserId })).status, 400)
    assert.equal((await primaryAgent.put('/api/journals/2026-02-02').set('Origin', frontendOrigin).send({ content: 'Không đổi thời gian', version: null, updatedAt: new Date().toISOString() })).status, 400)

    const leapDay = await saveJournal(primaryAgent, '2028-02-29', 'Ngày nhuận hợp lệ', null)
    assert.equal(leapDay.status, 201)
  })

  test('two concurrent creates produce one journal and one conflict', async () => {
    const date = '2026-02-03'
    const results = await Promise.all([
      saveJournal(primaryAgent, date, 'Nội dung từ tab một', null),
      saveJournal(primaryAgent, date, 'Nội dung từ tab hai', null),
    ])
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409])
    assert.equal(await Journal.countDocuments({ userId: primaryUserId, date }), 1)
  })

  test('two updates with the same version allow one writer and reject the stale writer', async () => {
    const date = '2026-02-01'
    const current = await primaryAgent.get(`/api/journals/${date}`)
    assert.equal(current.body.journal.version, 1)
    const results = await Promise.all([
      saveJournal(primaryAgent, date, 'Tab một đã lưu', 1),
      saveJournal(primaryAgent, date, 'Tab hai đã lưu', 1),
    ])
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409])
    const latest = await primaryAgent.get(`/api/journals/${date}`)
    assert.equal(latest.body.journal.version, 2)
    assert.ok(['Tab một đã lưu', 'Tab hai đã lưu'].includes(latest.body.journal.content))
    assert.equal((await saveJournal(primaryAgent, date, 'Ghi đè bằng version cũ', 1)).status, 409)
  })

  test('delete rejects a stale version and removes only the current version', async () => {
    const date = '2026-02-01'
    assert.equal((await deleteJournal(primaryAgent, date, 1)).status, 409)
    const current = await primaryAgent.get(`/api/journals/${date}`)
    const deleted = await deleteJournal(primaryAgent, date, current.body.journal.version)
    assert.equal(deleted.status, 204)
    assert.deepEqual((await primaryAgent.get(`/api/journals/${date}`)).body, { journal: null })
    assert.equal((await deleteJournal(primaryAgent, date, current.body.journal.version)).status, 404)
  })

  test('range list is descending, paginated and returns excerpts instead of full content', async () => {
    const userId = new mongoose.Types.ObjectId(primaryUserId)
    await Journal.insertMany(Array.from({ length: 25 }, (_, index) => ({
      content: `Nhật ký ${index + 1}\n${'nội dung dài '.repeat(20)}`,
      date: `2026-04-${String(index + 1).padStart(2, '0')}`,
      userId,
    })))

    const first = await primaryAgent.get('/api/journals?from=2026-04-01&to=2026-04-30&page=1&limit=10')
    assert.equal(first.status, 200)
    assert.deepEqual(first.body.pagination, { page: 1, limit: 10, total: 25, pages: 3 })
    assert.equal(first.body.journals.length, 10)
    assert.equal(first.body.journals[0].date, '2026-04-25')
    assert.equal(first.body.journals[9].date, '2026-04-16')
    assert.ok(first.body.journals.every((journal: { content?: string; excerpt: string }) => !('content' in journal) && journal.excerpt.length <= 160 && !journal.excerpt.includes('\n')))

    const second = await primaryAgent.get('/api/journals?from=2026-04-01&to=2026-04-30&page=2&limit=10')
    assert.equal(second.status, 200)
    assert.equal(second.body.journals[0].date, '2026-04-15')
  })

  test('list validates dates, the 366-day range and pagination', async () => {
    assert.equal((await primaryAgent.get('/api/journals?from=2024-01-01&to=2024-12-31')).status, 200)
    assert.equal((await primaryAgent.get('/api/journals?from=2024-01-01&to=2025-01-01')).status, 400)
    assert.equal((await primaryAgent.get('/api/journals?from=2026-03-02&to=2026-03-01')).status, 400)
    assert.equal((await primaryAgent.get('/api/journals?from=2026-02-29&to=2026-03-01')).status, 400)
    assert.equal((await primaryAgent.get('/api/journals?from=2026-03-01')).status, 400)
    assert.equal((await primaryAgent.get('/api/journals?from=2026-03-01&to=2026-03-02&page=0')).status, 400)
    assert.equal((await primaryAgent.get('/api/journals?from=2026-03-01&to=2026-03-02&limit=101')).status, 400)
    assert.equal((await primaryAgent.get('/api/journals?from=2026-03-01&to=2026-03-02&extra=true')).status, 400)
  })

  test('journals are isolated by owner for read, write, delete and list', async () => {
    const date = '2026-05-01'
    const primary = await saveJournal(primaryAgent, date, 'Nhật ký riêng của tài khoản chính', null)
    assert.equal(primary.status, 201)
    assert.deepEqual((await secondaryAgent.get(`/api/journals/${date}`)).body, { journal: null })
    assert.equal((await saveJournal(secondaryAgent, date, 'Không được ghi đè', 1)).status, 404)
    assert.equal((await deleteJournal(secondaryAgent, date, 1)).status, 404)

    const secondary = await saveJournal(secondaryAgent, date, 'Nhật ký riêng của tài khoản thứ hai', null)
    assert.equal(secondary.status, 201)
    const secondaryList = await secondaryAgent.get(`/api/journals?from=${date}&to=${date}`)
    assert.equal(secondaryList.body.pagination.total, 1)
    assert.match(secondaryList.body.journals[0].excerpt, /tài khoản thứ hai/)
    const primaryRead = await primaryAgent.get(`/api/journals/${date}`)
    assert.equal(primaryRead.body.journal.content, 'Nhật ký riêng của tài khoản chính')
  })
})
