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
import { TaskSeries } from '../models/TaskSeries.js'
import { User } from '../models/User.js'

const frontendOrigin = 'http://localhost:5173'
const runId = randomUUID().replaceAll('-', '')
const testDomain = `${runId}.stage3b1.test`
const validPassword = 'MatKhauLap!12345'
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

function seriesBody(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-06-01',
    name: 'Công việc lặp',
    startTime: '09:00',
    endTime: '10:00',
    priority: 'normal',
    group: 'Kế hoạch',
    description: 'Mô tả chuỗi',
    repeat: { frequency: 'daily', endDate: '2026-06-03' },
    ...overrides,
  }
}

function createSeries(agent: ReturnType<typeof request.agent>, overrides: Record<string, unknown> = {}) {
  return agent.post('/api/tasks/series').set('Origin', frontendOrigin).send(seriesBody(overrides))
}

async function allTasks(agent: ReturnType<typeof request.agent>, from: string, to: string) {
  const first = await agent.get(`/api/tasks?from=${from}&to=${to}&page=1&limit=100`)
  assert.equal(first.status, 200)
  const tasks = [...first.body.tasks]
  for (let page = 2; page <= first.body.pagination.pages; page += 1) {
    const result = await agent.get(`/api/tasks?from=${from}&to=${to}&page=${page}&limit=100`)
    assert.equal(result.status, 200)
    tasks.push(...result.body.tasks)
  }
  return tasks
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
  primaryUserId = await registerAndLogin(primaryAgent, primaryEmail, 'Người dùng lặp')
  await registerAndLogin(secondaryAgent, secondaryEmail, 'Người dùng lặp thứ hai')
})

after(async () => {
  if (mongoose.connection.readyState !== 1) return
  assert.equal(mongoose.connection.name, 'daytrail_test')
  const users = await User.find({ email: { $regex: `@${testDomain.replaceAll('.', '\\.')}$` } }).select('_id')
  const userIds = users.map((user) => user._id)
  if (userIds.length > 0) {
    await Task.deleteMany({ userId: { $in: userIds } })
    await TaskSeries.deleteMany({ userId: { $in: userIds } })
    await Session.deleteMany({ userId: { $in: userIds } })
    await User.deleteMany({ _id: { $in: userIds } })
  }
  assert.equal(await Task.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await TaskSeries.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await Session.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await User.countDocuments({ _id: { $in: userIds } }), 0)
  await disconnectDatabase()
})

describe('DayTrail recurrence integration', { concurrency: 1 }, () => {
  test('series routes require authentication, Origin and JSON while indexes protect generated dates', async () => {
    assert.equal((await request(app).post('/api/tasks/series').set('Origin', frontendOrigin).send(seriesBody())).status, 401)
    assert.equal((await primaryAgent.post('/api/tasks/series').set('Origin', 'https://example.invalid').send(seriesBody())).status, 403)
    assert.equal((await primaryAgent.post('/api/tasks/series').set('Origin', frontendOrigin).type('form').send(seriesBody())).status, 415)
    assert.equal((await primaryAgent.post('/api/tasks/series/not-an-id/stop').set('Origin', frontendOrigin).send({ fromDate: '2026-06-01' })).status, 400)

    const taskIndexes = await Task.collection.indexes()
    const uniqueOccurrence = taskIndexes.find((index) => index.name === 'unique_task_series_original_date')
    assert.equal(uniqueOccurrence?.unique, true)
    assert.equal(uniqueOccurrence?.key.userId, 1)
    assert.equal(uniqueOccurrence?.key.seriesId, 1)
    assert.equal(uniqueOccurrence?.key.originalDate, 1)
    const seriesIndexes = await TaskSeries.collection.indexes()
    assert.ok(seriesIndexes.some((index) => index.name === 'task_series_by_user_end_date'))
  })

  test('daily recurrence includes the end date and repeated reads never generate duplicates', async () => {
    const created = await createSeries(primaryAgent)
    assert.equal(created.status, 201)
    assert.equal(created.body.createdCount, 3)
    assert.equal(created.body.series.frequency, 'daily')
    assert.deepEqual(created.body.series.weekdays, [])
    assert.equal('userId' in created.body.series, false)
    const seriesDetail = await primaryAgent.get(`/api/tasks/series/${created.body.series.id}`)
    assert.equal(seriesDetail.status, 200)
    assert.equal(seriesDetail.body.series.startDate, '2026-06-01')
    assert.equal(seriesDetail.body.series.endDate, '2026-06-03')
    assert.equal((await secondaryAgent.get(`/api/tasks/series/${created.body.series.id}`)).status, 404)

    const firstRead = await allTasks(primaryAgent, '2026-06-01', '2026-06-03')
    const secondRead = await allTasks(primaryAgent, '2026-06-01', '2026-06-03')
    assert.deepEqual(firstRead.map((task) => task.date), ['2026-06-01', '2026-06-02', '2026-06-03'])
    assert.equal(secondRead.length, 3)
    assert.ok(firstRead.every((task) => task.recurrence.seriesId === created.body.series.id && task.recurrence.originalDate === task.date && task.repeat === 'daily'))
    assert.equal(await Task.countDocuments({ seriesId: created.body.series.id }), 3)
  })

  test('weekly recurrence supports multiple weekdays across a year boundary', async () => {
    const created = await createSeries(primaryAgent, {
      date: '2026-12-28',
      name: 'Tuần giao năm',
      repeat: { frequency: 'weekly', endDate: '2027-01-10', weekdays: [7, 1, 3] },
    })
    assert.equal(created.status, 201)
    assert.equal(created.body.createdCount, 6)
    assert.deepEqual(created.body.series.weekdays, [1, 3, 7])
    const tasks = await Task.find({ seriesId: created.body.series.id }).sort({ originalDate: 1 })
    assert.deepEqual(tasks.map((task) => task.originalDate), ['2026-12-28', '2026-12-30', '2027-01-03', '2027-01-04', '2027-01-06', '2027-01-10'])
  })

  test('monthly recurrence handles 29, 30 and 31 without shifting missing dates', async () => {
    const cases = [
      { start: '2024-01-29', end: '2024-04-30', expected: ['2024-01-29', '2024-02-29', '2024-03-29', '2024-04-29'] },
      { start: '2024-01-30', end: '2024-04-30', expected: ['2024-01-30', '2024-03-30', '2024-04-30'] },
      { start: '2027-01-31', end: '2027-05-31', expected: ['2027-01-31', '2027-03-31', '2027-05-31'] },
    ]
    for (const [index, item] of cases.entries()) {
      const created = await createSeries(primaryAgent, {
        date: item.start,
        name: `Ngày cuối tháng ${index + 1}`,
        repeat: { frequency: 'monthly', endDate: item.end },
      })
      assert.equal(created.status, 201)
      const tasks = await Task.find({ seriesId: created.body.series.id }).sort({ originalDate: 1 })
      assert.deepEqual(tasks.map((task) => task.originalDate), item.expected)
    }
  })

  test('validation rejects invalid rules and accepts exactly 366 inclusive days', async () => {
    const seriesBefore = await TaskSeries.countDocuments({ userId: primaryUserId })
    const taskBefore = await Task.countDocuments({ userId: primaryUserId })
    const invalidBodies = [
      { repeat: { frequency: 'daily', endDate: '2026-05-31' } },
      { repeat: { frequency: 'daily', endDate: '2027-06-02' } },
      { repeat: { frequency: 'weekly', endDate: '2026-06-03' } },
      { repeat: { frequency: 'weekly', endDate: '2026-06-03', weekdays: [] } },
      { repeat: { frequency: 'weekly', endDate: '2026-06-03', weekdays: [1, 1] } },
      { repeat: { frequency: 'weekly', endDate: '2026-06-03', weekdays: [0] } },
      { repeat: { frequency: 'monthly', endDate: '2026-06-03', weekdays: [1] } },
      { repeat: { frequency: 'yearly', endDate: '2026-06-03' } },
      { repeat: { frequency: 'weekly', endDate: '2026-06-01', weekdays: [2] } },
      { note: 'Không được đặt note' },
      { completed: true },
    ]
    for (const overrides of invalidBodies) assert.equal((await createSeries(primaryAgent, overrides)).status, 400)
    assert.equal(await TaskSeries.countDocuments({ userId: primaryUserId }), seriesBefore)
    assert.equal(await Task.countDocuments({ userId: primaryUserId }), taskBefore)
    assert.equal((await primaryAgent.post('/api/tasks').set('Origin', frontendOrigin).send({
      date: '2026-06-01', name: 'Không dùng API một lần', startTime: '09:00', endTime: '10:00', repeat: 'daily',
    })).status, 400)

    const maximum = await createSeries(primaryAgent, {
      date: '2024-01-01',
      name: 'Chuỗi đủ 366 ngày',
      repeat: { frequency: 'daily', endDate: '2024-12-31' },
    })
    assert.equal(maximum.status, 201)
    assert.equal(maximum.body.createdCount, 366)
  })

  test('each occurrence keeps independent plan, note, completion, move and deletion state', async () => {
    const created = await createSeries(primaryAgent, {
      date: '2026-07-01',
      name: 'Hai lần độc lập',
      repeat: { frequency: 'daily', endDate: '2026-07-02' },
    })
    const tasks = await Task.find({ seriesId: created.body.series.id }).sort({ originalDate: 1 })
    const firstId = tasks[0]?._id.toString()
    const secondId = tasks[1]?._id.toString()
    assert.ok(firstId && secondId)
    assert.equal((await primaryAgent.patch(`/api/tasks/${firstId}`).set('Origin', frontendOrigin).send({ name: 'Chỉ sửa lần đầu', note: 'Note riêng' })).status, 200)
    assert.equal((await primaryAgent.patch(`/api/tasks/${firstId}/completion`).set('Origin', frontendOrigin).send({ completed: true })).status, 200)
    const moved = await primaryAgent.patch(`/api/tasks/${firstId}/date`).set('Origin', frontendOrigin).send({ date: '2026-07-10' })
    assert.equal(moved.status, 200)
    assert.equal(moved.body.task.recurrence.originalDate, '2026-07-01')
    const untouched = await primaryAgent.get(`/api/tasks/${secondId}`)
    assert.equal(untouched.body.task.name, 'Hai lần độc lập')
    assert.equal(untouched.body.task.note, null)
    assert.equal(untouched.body.task.completed, false)
    assert.equal((await primaryAgent.delete(`/api/tasks/${firstId}`).set('Origin', frontendOrigin).set('Content-Type', 'application/json').send({})).status, 204)
    assert.equal((await primaryAgent.get(`/api/tasks/${secondId}`)).status, 200)
    assert.equal(await Task.countDocuments({ seriesId: created.body.series.id }), 1)
  })

  test('stopping a series preserves history and uses original dates for moved occurrences', async () => {
    const created = await createSeries(primaryAgent, {
      date: '2026-08-10',
      name: 'Chuỗi cần dừng',
      repeat: { frequency: 'daily', endDate: '2026-08-14' },
    })
    const tasks = await Task.find({ seriesId: created.body.series.id }).sort({ originalDate: 1 })
    const byOriginalDate = new Map(tasks.map((task) => [task.originalDate, task._id.toString()]))
    assert.equal((await primaryAgent.patch(`/api/tasks/${byOriginalDate.get('2026-08-11')}`).set('Origin', frontendOrigin).send({ note: 'Giữ vì có note' })).status, 200)
    assert.equal((await primaryAgent.patch(`/api/tasks/${byOriginalDate.get('2026-08-12')}/completion`).set('Origin', frontendOrigin).send({ completed: true })).status, 200)
    assert.equal((await primaryAgent.patch(`/api/tasks/${byOriginalDate.get('2026-08-13')}/date`).set('Origin', frontendOrigin).send({ date: '2026-08-20' })).status, 200)

    const stopped = await primaryAgent.post(`/api/tasks/series/${created.body.series.id}/stop`).set('Origin', frontendOrigin).send({ fromDate: '2026-08-11' })
    assert.equal(stopped.status, 200)
    assert.equal(stopped.body.removedCount, 2)
    assert.equal(stopped.body.keptCount, 2)
    assert.equal(stopped.body.series.stoppedFromDate, '2026-08-11')
    const remaining = await Task.find({ seriesId: created.body.series.id }).sort({ originalDate: 1 })
    assert.deepEqual(remaining.map((task) => task.originalDate), ['2026-08-10', '2026-08-11', '2026-08-12'])
    assert.equal(remaining.some((task) => task.date === '2026-08-20'), false)

    const stoppedAgain = await primaryAgent.post(`/api/tasks/series/${created.body.series.id}/stop`).set('Origin', frontendOrigin).send({ fromDate: '2026-08-11' })
    assert.equal(stoppedAgain.status, 200)
    assert.equal(stoppedAgain.body.removedCount, 0)
    assert.equal(stoppedAgain.body.keptCount, 2)
    assert.equal(await Task.countDocuments({ seriesId: created.body.series.id }), 3)
  })

  test('series ownership is isolated between accounts', async () => {
    const created = await createSeries(primaryAgent, {
      date: '2026-09-01',
      name: 'Chuỗi riêng tư',
      repeat: { frequency: 'daily', endDate: '2026-09-02' },
    })
    const forbiddenStop = await secondaryAgent.post(`/api/tasks/series/${created.body.series.id}/stop`).set('Origin', frontendOrigin).send({ fromDate: '2026-09-01' })
    assert.equal(forbiddenStop.status, 404)
    const secondaryTasks = await allTasks(secondaryAgent, '2026-09-01', '2026-09-02')
    assert.deepEqual(secondaryTasks, [])
    assert.equal((await primaryAgent.post(`/api/tasks/series/${created.body.series.id}/stop`).set('Origin', frontendOrigin).send({ fromDate: '2026-08-31' })).status, 400)
  })

  test('a transaction failure leaves neither a series nor generated occurrences', async () => {
    const seriesBefore = await TaskSeries.countDocuments({ userId: primaryUserId })
    const tasksBefore = await Task.countDocuments({ userId: primaryUserId })
    const originalInsertMany = Task.insertMany
    const model = Task as unknown as { insertMany: typeof Task.insertMany }
    model.insertMany = (async () => { throw new Error('Forced occurrence insert failure') }) as typeof Task.insertMany
    try {
      const failed = await createSeries(primaryAgent, {
        date: '2026-10-01',
        name: 'Transaction phải rollback',
        repeat: { frequency: 'daily', endDate: '2026-10-02' },
      })
      assert.equal(failed.status, 500)
    } finally {
      model.insertMany = originalInsertMany
    }
    assert.equal(await TaskSeries.countDocuments({ userId: primaryUserId }), seriesBefore)
    assert.equal(await Task.countDocuments({ userId: primaryUserId }), tasksBefore)
  })

  test('one-time tasks and occurrences share lists and summaries without counting the series document', async () => {
    const date = '2026-11-01'
    const oneTime = await primaryAgent.post('/api/tasks').set('Origin', frontendOrigin).send({
      date, name: 'Công việc một lần', startTime: '08:00', endTime: '09:00', repeat: 'none',
    })
    assert.equal(oneTime.status, 201)
    const recurring = await createSeries(primaryAgent, {
      date,
      name: 'Một lần trong chuỗi',
      startTime: '10:00',
      endTime: '11:00',
      repeat: { frequency: 'daily', endDate: date },
    })
    assert.equal(recurring.status, 201)
    const listed = await primaryAgent.get(`/api/tasks?date=${date}&page=1&limit=100`)
    assert.equal(listed.body.pagination.total, 2)
    assert.equal(listed.body.tasks.filter((task: { recurrence: unknown }) => task.recurrence !== null).length, 1)
    const summary = await primaryAgent.get(`/api/tasks/summary?date=${date}`)
    assert.equal(summary.body.total, 2)
    const rangeSummary = await primaryAgent.get(`/api/tasks/summaries?from=${date}&to=${date}`)
    assert.equal(rangeSummary.body.summaries[0].total, 2)
  })
})
