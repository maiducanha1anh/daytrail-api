import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import type { Express } from 'express'
import mongoose from 'mongoose'
import request from 'supertest'
import { createApp } from '../app.js'
import { loadTestConfig } from '../config/env.js'
import { connectDatabase, disconnectDatabase, pingDatabase } from '../database/mongoose.js'
import { ensureDatabaseIndexes } from '../models/indexes.js'
import { Session } from '../models/Session.js'
import { Task } from '../models/Task.js'
import { User } from '../models/User.js'

const frontendOrigin = 'http://localhost:5173'
const runId = randomUUID().replaceAll('-', '')
const testDomain = `${runId}.stage2a.test`
const validPassword = 'MatKhauRatManh!123'
const primaryEmail = `primary@${testDomain}`
const secondaryEmail = `secondary@${testDomain}`
const baseDate = '2026-02-10'
const movedDate = '2026-02-12'
const summaryDate = '2026-03-01'
const summaryTargetDate = '2026-03-02'
let app: Express
let pingTimeoutMs = 3_000
let primaryAgent: ReturnType<typeof request.agent>
let secondaryAgent: ReturnType<typeof request.agent>
let primaryUserId = ''
let secondaryUserId = ''
let mainTaskId = ''

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
  const registration = await agent
    .post('/api/auth/register')
    .set('Origin', frontendOrigin)
    .send({ displayName, email, password: validPassword })
  assert.equal(registration.status, 201)
  const login = await agent
    .post('/api/auth/login')
    .set('Origin', frontendOrigin)
    .send({ email, password: validPassword })
  assert.equal(login.status, 200)
  return registration.body.user.id as string
}

function validTask(overrides: Record<string, unknown> = {}) {
  return {
    date: baseDate,
    name: 'Viết kế hoạch ngày',
    startTime: '09:00',
    endTime: '10:00',
    repeat: 'none',
    ...overrides,
  }
}

function createTask(agent: ReturnType<typeof request.agent>, overrides: Record<string, unknown> = {}) {
  return agent.post('/api/tasks').set('Origin', frontendOrigin).send(validTask(overrides))
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
  primaryUserId = await registerAndLogin(primaryAgent, primaryEmail, 'Người dùng công việc')
  secondaryUserId = await registerAndLogin(secondaryAgent, secondaryEmail, 'Người dùng thứ hai')
})

after(async () => {
  if (mongoose.connection.readyState !== 1) return
  assert.equal(mongoose.connection.name, 'daytrail_test')
  const users = await User.find({ email: { $regex: `@${testDomain.replaceAll('.', '\\.')}$` } }).select('_id')
  const userIds = users.map((user) => user._id)
  if (userIds.length) {
    await Task.deleteMany({ userId: { $in: userIds } })
    await Session.deleteMany({ userId: { $in: userIds } })
    await User.deleteMany({ _id: { $in: userIds } })
  }
  assert.equal(await Task.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await Session.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await User.countDocuments({ _id: { $in: userIds } }), 0)
  await disconnectDatabase()
})

describe('DayTrail task integration', { concurrency: 1 }, () => {
  test('all task routes require a session and writes enforce Origin and JSON', async () => {
    assert.equal((await request(app).get(`/api/tasks?date=${baseDate}`)).status, 401)
    assert.equal((await request(app).get(`/api/tasks/summary?date=${baseDate}`)).status, 401)
    assert.equal((await request(app).get(`/api/tasks/summaries?from=${baseDate}&to=${baseDate}`)).status, 401)
    assert.equal((await request(app).post('/api/tasks').set('Origin', frontendOrigin).send(validTask())).status, 401)

    const wrongOrigin = await primaryAgent.post('/api/tasks').set('Origin', 'https://example.invalid').send(validTask())
    assert.equal(wrongOrigin.status, 403)
    const wrongType = await primaryAgent.post('/api/tasks').set('Origin', frontendOrigin).type('form').send(validTask())
    assert.equal(wrongType.status, 415)
    assert.equal((await primaryAgent.get('/api/tasks/not-an-object-id')).status, 400)

    const taskIndexes = await Task.collection.indexes()
    const queryIndex = taskIndexes.find((index) => index.name === 'tasks_by_user_date_time')
    assert.equal(queryIndex?.key.userId, 1)
    assert.equal(queryIndex?.key.date, 1)
    assert.equal(queryIndex?.key.startTime, 1)
    assert.equal(queryIndex?.key._id, 1)
  })

  test('create uses the session owner, defaults fields, and rejects unsupported/system fields', async () => {
    const created = await createTask(primaryAgent, {
      group: 'Cá nhân',
      description: 'Mô tả kế hoạch',
      note: 'Ghi chú ban đầu',
    })
    assert.equal(created.status, 201)
    assert.equal(created.body.task.priority, 'normal')
    assert.equal(created.body.task.repeat, 'none')
    assert.equal(created.body.task.completed, false)
    assert.equal(created.body.task.completedAt, null)
    assert.equal(created.body.task.group, 'Cá nhân')
    assert.equal('userId' in created.body.task, false)
    mainTaskId = created.body.task.id

    for (const injected of [
      { userId: primaryUserId },
      { completed: true },
      { completedAt: new Date().toISOString() },
      { createdAt: new Date().toISOString() },
      { updatedAt: new Date().toISOString() },
    ]) {
      assert.equal((await createTask(primaryAgent, injected)).status, 400)
    }
    assert.equal((await createTask(primaryAgent, { repeat: 'daily' })).status, 400)
    assert.equal((await createTask(primaryAgent, { repeat: 1 })).status, 400)
  })

  test('date, leap year, time, enum, type, and text limits are validated', async () => {
    assert.equal((await createTask(primaryAgent, { date: '2025-02-29' })).status, 400)
    const leapDay = await createTask(primaryAgent, { date: '2024-02-29', name: 'Ngày nhuận' })
    assert.equal(leapDay.status, 201)

    for (const overrides of [
      { date: '2026-13-01' },
      { date: '10/02/2026' },
      { startTime: '9:00' },
      { startTime: '24:00' },
      { endTime: '09:00' },
      { endTime: '08:59' },
      { priority: 'urgent' },
      { priority: 1 },
      { name: 42 },
      { name: 'x'.repeat(121) },
      { group: 'x'.repeat(81) },
      { description: 'x'.repeat(2_001) },
      { note: 'x'.repeat(5_001) },
    ]) {
      assert.equal((await createTask(primaryAgent, overrides)).status, 400)
    }
  })

  test('list filters by date/range, sorts stably, and paginates within a bounded range', async () => {
    await createTask(primaryAgent, { date: baseDate, name: 'Sớm', startTime: '08:00', endTime: '08:30' })
    await createTask(primaryAgent, { date: baseDate, name: 'Cùng giờ A', startTime: '09:00', endTime: '09:30' })
    await createTask(primaryAgent, { date: '2026-02-11', name: 'Ngày kế', startTime: '07:00', endTime: '08:00' })

    const byDate = await primaryAgent.get(`/api/tasks?date=${baseDate}&page=1&limit=100`)
    assert.equal(byDate.status, 200)
    assert.ok(byDate.body.tasks.length >= 3)
    const sorted = [...byDate.body.tasks].sort((left, right) => left.startTime.localeCompare(right.startTime) || left.id.localeCompare(right.id))
    assert.deepEqual(byDate.body.tasks.map((task: { id: string }) => task.id), sorted.map((task: { id: string }) => task.id))

    const range = await primaryAgent.get('/api/tasks?from=2026-02-10&to=2026-02-11&page=1&limit=2')
    assert.equal(range.status, 200)
    assert.equal(range.body.tasks.length, 2)
    assert.ok(range.body.pagination.total >= 4)
    assert.equal(range.body.pagination.page, 1)
    assert.equal(range.body.pagination.limit, 2)
    const pageTwo = await primaryAgent.get('/api/tasks?from=2026-02-10&to=2026-02-11&page=2&limit=2')
    assert.equal(pageTwo.status, 200)
    assert.ok(pageTwo.body.tasks.length >= 1)

    assert.equal((await primaryAgent.get('/api/tasks?from=2026-01-01')).status, 400)
    assert.equal((await primaryAgent.get('/api/tasks?date=2026-02-10&from=2026-02-10&to=2026-02-11')).status, 400)
    assert.equal((await primaryAgent.get('/api/tasks?from=2025-01-01&to=2026-01-02')).status, 400)
    assert.equal((await primaryAgent.get('/api/tasks?date=2026-02-10&limit=101')).status, 400)
  })

  test('detail and editable fields work while ownership/system fields remain immutable', async () => {
    const detail = await primaryAgent.get(`/api/tasks/${mainTaskId}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.task.id, mainTaskId)

    const updated = await primaryAgent
      .patch(`/api/tasks/${mainTaskId}`)
      .set('Origin', frontendOrigin)
      .send({
        name: 'Tên đã sửa',
        startTime: '10:00',
        endTime: '11:30',
        priority: 'high',
        group: 'Công việc',
        description: 'Mô tả đã sửa',
        note: 'Note khác mô tả',
      })
    assert.equal(updated.status, 200)
    assert.equal(updated.body.task.name, 'Tên đã sửa')
    assert.equal(updated.body.task.note, 'Note khác mô tả')
    assert.equal(updated.body.task.description, 'Mô tả đã sửa')

    assert.equal((await primaryAgent.patch(`/api/tasks/${mainTaskId}`).set('Origin', frontendOrigin).send({ startTime: '12:00' })).status, 400)
    assert.equal((await primaryAgent.patch(`/api/tasks/${mainTaskId}`).set('Origin', frontendOrigin).send({})).status, 400)
    for (const protectedField of ['userId', 'completed', 'completedAt', 'date', 'repeat', 'createdAt', 'updatedAt']) {
      const result = await primaryAgent.patch(`/api/tasks/${mainTaskId}`).set('Origin', frontendOrigin).send({ [protectedField]: 'blocked' })
      assert.equal(result.status, 400)
    }
  })

  test('completion is explicit/idempotent, note remains editable, and moving preserves state', async () => {
    const completed = await primaryAgent.patch(`/api/tasks/${mainTaskId}/completion`).set('Origin', frontendOrigin).send({ completed: true })
    assert.equal(completed.status, 200)
    assert.equal(completed.body.task.completed, true)
    assert.equal(typeof completed.body.task.completedAt, 'string')
    const completedAt = completed.body.task.completedAt

    const completedAgain = await primaryAgent.patch(`/api/tasks/${mainTaskId}/completion`).set('Origin', frontendOrigin).send({ completed: true })
    assert.equal(completedAgain.status, 200)
    assert.equal(completedAgain.body.task.completedAt, completedAt)

    const noted = await primaryAgent.patch(`/api/tasks/${mainTaskId}`).set('Origin', frontendOrigin).send({ note: 'Note sau khi hoàn thành' })
    assert.equal(noted.status, 200)
    assert.equal(noted.body.task.note, 'Note sau khi hoàn thành')
    assert.equal(noted.body.task.completedAt, completedAt)

    const moved = await primaryAgent.patch(`/api/tasks/${mainTaskId}/date`).set('Origin', frontendOrigin).send({ date: movedDate })
    assert.equal(moved.status, 200)
    assert.equal(moved.body.task.date, movedDate)
    assert.equal(moved.body.task.note, 'Note sau khi hoàn thành')
    assert.equal(moved.body.task.description, 'Mô tả đã sửa')
    assert.equal(moved.body.task.completed, true)
    assert.equal(moved.body.task.completedAt, completedAt)

    const reopened = await primaryAgent.patch(`/api/tasks/${mainTaskId}/completion`).set('Origin', frontendOrigin).send({ completed: false })
    assert.equal(reopened.status, 200)
    assert.equal(reopened.body.task.completed, false)
    assert.equal(reopened.body.task.completedAt, null)
    const reopenedAgain = await primaryAgent.patch(`/api/tasks/${mainTaskId}/completion`).set('Origin', frontendOrigin).send({ completed: false })
    assert.equal(reopenedAgain.body.task.completedAt, null)

    assert.equal((await primaryAgent.patch(`/api/tasks/${mainTaskId}/completion`).set('Origin', frontendOrigin).send({ completed: 'true' })).status, 400)
    assert.equal((await primaryAgent.patch(`/api/tasks/${mainTaskId}/date`).set('Origin', frontendOrigin).send({ date: '2026-02-30' })).status, 400)
  })

  test('daily summary stays correct after completion, moving, and deletion', async () => {
    const first = await createTask(primaryAgent, { date: summaryDate, name: 'Tổng quan một', startTime: '08:00', endTime: '09:00' })
    const second = await createTask(primaryAgent, { date: summaryDate, name: 'Tổng quan hai', startTime: '09:00', endTime: '10:00' })
    assert.equal(first.status, 201)
    assert.equal(second.status, 201)
    const firstId = first.body.task.id as string
    const secondId = second.body.task.id as string
    assert.equal((await primaryAgent.patch(`/api/tasks/${firstId}/completion`).set('Origin', frontendOrigin).send({ completed: true })).status, 200)

    const half = await primaryAgent.get(`/api/tasks/summary?date=${summaryDate}`)
    assert.deepEqual(half.body, { date: summaryDate, total: 2, completed: 1, incomplete: 1, completionPercentage: 50 })

    assert.equal((await primaryAgent.patch(`/api/tasks/${secondId}/date`).set('Origin', frontendOrigin).send({ date: summaryTargetDate })).status, 200)
    const source = await primaryAgent.get(`/api/tasks/summary?date=${summaryDate}`)
    assert.deepEqual(source.body, { date: summaryDate, total: 1, completed: 1, incomplete: 0, completionPercentage: 100 })
    const target = await primaryAgent.get(`/api/tasks/summary?date=${summaryTargetDate}`)
    assert.deepEqual(target.body, { date: summaryTargetDate, total: 1, completed: 0, incomplete: 1, completionPercentage: 0 })

    assert.equal((await primaryAgent.delete(`/api/tasks/${firstId}`).set('Origin', frontendOrigin).set('Content-Type', 'application/json').send({})).status, 204)
    const empty = await primaryAgent.get(`/api/tasks/summary?date=${summaryDate}`)
    assert.deepEqual(empty.body, { date: summaryDate, total: 0, completed: 0, incomplete: 0, completionPercentage: 0 })
  })

  test('range summaries cover all matching tasks, omit empty days, and isolate owners', async () => {
    const rangeDate = '2026-04-01'
    const secondDate = '2026-04-02'
    const emptyDate = '2026-04-03'
    const records = Array.from({ length: 105 }, (_, index) => ({
      userId: new mongoose.Types.ObjectId(primaryUserId),
      date: rangeDate,
      name: `Tổng hợp ${index + 1}`,
      startTime: '08:00',
      endTime: '09:00',
      priority: 'normal',
      repeat: 'none',
      completed: index < 21,
      completedAt: index < 21 ? new Date() : null,
    }))
    records.push({
      userId: new mongoose.Types.ObjectId(primaryUserId),
      date: secondDate,
      name: 'Ngày thứ hai',
      startTime: '09:00',
      endTime: '10:00',
      priority: 'normal',
      repeat: 'none',
      completed: true,
      completedAt: new Date(),
    })
    await Task.insertMany(records)
    await Task.create({
      userId: new mongoose.Types.ObjectId(secondaryUserId),
      date: rangeDate,
      name: 'Dữ liệu tài khoản khác',
      startTime: '10:00',
      endTime: '11:00',
      priority: 'normal',
      repeat: 'none',
    })

    const result = await primaryAgent.get(`/api/tasks/summaries?from=${rangeDate}&to=${emptyDate}`)
    assert.equal(result.status, 200)
    assert.equal(result.body.from, rangeDate)
    assert.equal(result.body.to, emptyDate)
    assert.deepEqual(result.body.summaries, [
      { date: rangeDate, total: 105, completed: 21, incomplete: 84, completionPercentage: 20 },
      { date: secondDate, total: 1, completed: 1, incomplete: 0, completionPercentage: 100 },
    ])

    const isolated = await secondaryAgent.get(`/api/tasks/summaries?from=${rangeDate}&to=${emptyDate}`)
    assert.equal(isolated.status, 200)
    assert.deepEqual(isolated.body.summaries, [
      { date: rangeDate, total: 1, completed: 0, incomplete: 1, completionPercentage: 0 },
    ])

    assert.equal((await primaryAgent.get('/api/tasks/summaries?from=2026-04-01')).status, 400)
    assert.equal((await primaryAgent.get('/api/tasks/summaries?from=2026-04-03&to=2026-04-01')).status, 400)
    assert.equal((await primaryAgent.get('/api/tasks/summaries?from=2025-01-01&to=2026-01-02')).status, 400)
    assert.equal((await primaryAgent.get('/api/tasks/summaries?from=2024-01-01&to=2024-12-31')).status, 200)
  })

  test('a second account cannot view, edit, move, complete, or delete another user task', async () => {
    assert.equal((await secondaryAgent.get(`/api/tasks/${mainTaskId}`)).status, 404)
    assert.equal((await secondaryAgent.patch(`/api/tasks/${mainTaskId}`).set('Origin', frontendOrigin).send({ name: 'Chiếm quyền' })).status, 404)
    assert.equal((await secondaryAgent.patch(`/api/tasks/${mainTaskId}/date`).set('Origin', frontendOrigin).send({ date: '2026-04-01' })).status, 404)
    assert.equal((await secondaryAgent.patch(`/api/tasks/${mainTaskId}/completion`).set('Origin', frontendOrigin).send({ completed: true })).status, 404)
    assert.equal((await secondaryAgent.delete(`/api/tasks/${mainTaskId}`).set('Origin', frontendOrigin).set('Content-Type', 'application/json').send({})).status, 404)
    const list = await secondaryAgent.get(`/api/tasks?date=${movedDate}`)
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.tasks, [])
  })

  test('the owner can delete a task and receives 404 afterward', async () => {
    const deleted = await primaryAgent.delete(`/api/tasks/${mainTaskId}`).set('Origin', frontendOrigin).set('Content-Type', 'application/json').send({})
    assert.equal(deleted.status, 204)
    assert.equal((await primaryAgent.get(`/api/tasks/${mainTaskId}`)).status, 404)
    assert.equal((await primaryAgent.delete(`/api/tasks/${mainTaskId}`).set('Origin', frontendOrigin).set('Content-Type', 'application/json').send({})).status, 404)
  })
})
