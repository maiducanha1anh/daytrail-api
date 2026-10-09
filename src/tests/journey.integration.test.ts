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
import { JourneyAlbum } from '../models/JourneyAlbum.js'
import { JourneyHighlight } from '../models/JourneyHighlight.js'
import { JourneyPhase } from '../models/JourneyPhase.js'
import { MediaAsset } from '../models/MediaAsset.js'
import { ensureDatabaseIndexes } from '../models/indexes.js'
import { Session } from '../models/Session.js'
import { Task } from '../models/Task.js'
import { TaskSeries } from '../models/TaskSeries.js'
import { User } from '../models/User.js'

const frontendOrigin = 'http://localhost:5173'
const runId = randomUUID().replaceAll('-', '')
const testDomain = `${runId}.stage5-album.test`
const validPassword = 'MatKhauAlbum!123'
const marchDates = ['2024-03-02', '2024-03-05', '2024-03-09', '2024-03-14', '2024-03-18', '2024-03-23', '2024-03-27', '2024-03-30']
let app: Express
let pingTimeoutMs = 3_000
let primaryAgent: ReturnType<typeof request.agent>
let secondaryAgent: ReturnType<typeof request.agent>
let primaryUserId = ''
let secondaryUserId = ''
let taskId = ''
let taskImageId = ''
let marchImageId = ''
let outsideImageId = ''
let secondaryImageId = ''

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

async function createMedia(userId: string, ownerType: 'task' | 'journal', ownerKey: string, suffix: string, quotaSlot = 0) {
  return MediaAsset.create({
    byteSize: 100,
    caption: `Ảnh ${suffix}`,
    cleanupAttempts: 0,
    cleanupReason: null,
    clientUploadId: randomUUID(),
    fullHeight: 600,
    fullWidth: 800,
    lastCleanupCode: null,
    mimeType: 'image/webp',
    nextCleanupAt: null,
    objectKeyFull: `daytrail/test/${runId}/${suffix}-full.webp`,
    objectKeyThumbnail: `daytrail/test/${runId}/${suffix}-thumbnail.webp`,
    ownerKey,
    ownerType,
    payloadHash: `${runId}${suffix}`.padEnd(64, '0').slice(0, 64),
    quotaSlot,
    status: 'ready',
    thumbnailByteSize: 50,
    thumbnailHeight: 300,
    thumbnailWidth: 400,
    userId,
    version: 1,
  })
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
  primaryUserId = await registerAndLogin(primaryAgent, `primary@${testDomain}`, 'Người xem Album')
  secondaryUserId = await registerAndLogin(secondaryAgent, `secondary@${testDomain}`, 'Tài khoản cách ly')

  const task = await primaryAgent.post('/api/tasks').set('Origin', frontendOrigin).send({
    date: '2024-03-14', name: 'Công việc không thuộc Album', startTime: '08:00', endTime: '09:00', note: 'Không được lộ', repeat: 'none',
  })
  assert.equal(task.status, 201)
  taskId = task.body.task.id
  taskImageId = (await createMedia(primaryUserId, 'task', taskId, 'task'))._id.toString()

  const journals = marchDates.map((date, index) => ({
    content: index === 4 ? '' : `Nhật ký ngày ${date}\nNội dung nguyên bản ${index}.`,
    date,
    userId: primaryUserId,
    version: 1,
  }))
  journals.push({ content: 'Ngày nhuận đáng nhớ.', date: '2024-02-29', userId: primaryUserId, version: 1 })
  journals.push({ content: 'Ngoài tháng ba.', date: '2024-04-01', userId: primaryUserId, version: 1 })
  await Journal.insertMany(journals)
  marchImageId = (await createMedia(primaryUserId, 'journal', '2024-03-18', 'march'))._id.toString()
  await createMedia(primaryUserId, 'journal', '2024-03-18', 'march-extra', 1)
  outsideImageId = (await createMedia(primaryUserId, 'journal', '2024-04-01', 'outside'))._id.toString()
  await Journal.create({ content: 'Nhật ký tài khoản khác.', date: '2024-03-18', userId: secondaryUserId, version: 1 })
  secondaryImageId = (await createMedia(secondaryUserId, 'journal', '2024-03-18', 'secondary'))._id.toString()
})

after(async () => {
  if (mongoose.connection.readyState !== 1) return
  assert.equal(mongoose.connection.name, 'daytrail_test')
  const users = await User.find({ email: { $regex: `@${testDomain.replaceAll('.', '\\.')}$` } }).select('_id')
  const userIds = users.map((user) => user._id)
  if (userIds.length > 0) {
    await JourneyAlbum.deleteMany({ userId: { $in: userIds } })
    await JourneyHighlight.deleteMany({ userId: { $in: userIds } })
    await JourneyPhase.deleteMany({ userId: { $in: userIds } })
    await MediaAsset.deleteMany({ userId: { $in: userIds } })
    await Journal.deleteMany({ userId: { $in: userIds } })
    await Task.deleteMany({ userId: { $in: userIds } })
    await TaskSeries.deleteMany({ userId: { $in: userIds } })
    await Session.deleteMany({ userId: { $in: userIds } })
    await User.deleteMany({ _id: { $in: userIds } })
  }
  assert.equal(await JourneyAlbum.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await JourneyHighlight.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await JourneyPhase.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await MediaAsset.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await User.countDocuments({ _id: { $in: userIds } }), 0)
  await disconnectDatabase()
})

describe('DayTrail memory album integration', { concurrency: 1 }, () => {
  test('requires authentication and validates dates, ranges and journal-only highlights', async () => {
    assert.equal((await request(app).get('/api/journey/year/2024')).status, 401)
    assert.equal((await primaryAgent.get('/api/journey/year/20x4')).status, 400)
    assert.equal((await primaryAgent.get('/api/journey/month/2024/13')).status, 400)
    assert.equal((await primaryAgent.get('/api/journey/days?from=2024-02-30&to=2024-03-01')).status, 400)
    assert.equal((await primaryAgent.get('/api/journey/days?from=2023-01-01&to=2024-01-02')).status, 400)
    assert.equal((await primaryAgent.post('/api/journey/highlights').set('Origin', frontendOrigin).send({ sourceType: 'task', sourceId: taskId })).status, 400)
    assert.equal((await primaryAgent.put('/api/journey/albums/2024/3').set('Origin', 'https://example.invalid').send({ title: '', coverImageId: null })).status, 403)
  })

  test('year and month summaries contain only journals and journal images', async () => {
    const year = await primaryAgent.get('/api/journey/year/2024')
    assert.equal(year.status, 200)
    assert.equal(year.body.months.length, 12)
    assert.equal(year.body.months[1].dayCount, 1)
    assert.equal(year.body.months[2].dayCount, 8)
    assert.equal(year.body.months[2].imageCount, 2)
    assert.equal(JSON.stringify(year.body).includes(taskId), false)
    assert.equal(JSON.stringify(year.body).includes(taskImageId), false)

    const month = await primaryAgent.get('/api/journey/month/2024/3')
    assert.equal(month.status, 200)
    assert.equal(month.body.previewDays.length, 6)
    assert.equal(new Set(month.body.previewDays.map((day: { date: string }) => day.date)).size, 6)
    assert.deepEqual([...month.body.previewDays.map((day: { date: string }) => day.date)].sort(), month.body.previewDays.map((day: { date: string }) => day.date))
    assert.equal(JSON.stringify(month.body).includes('Công việc không thuộc Album'), false)
    assert.equal((await secondaryAgent.get('/api/journey/year/2024')).body.months[2].dayCount, 1)
  })

  test('highlight selection is idempotent, isolated, stable and prioritised in six previews', async () => {
    const featuredJournal = await Journal.findOne({ userId: primaryUserId, date: '2024-03-30' })
    assert.ok(featuredJournal)
    const created = await primaryAgent.post('/api/journey/highlights').set('Origin', frontendOrigin).send({ sourceType: 'journal', sourceId: featuredJournal._id.toString() })
    assert.equal(created.status, 201)
    const repeated = await primaryAgent.post('/api/journey/highlights').set('Origin', frontendOrigin).send({ sourceType: 'journal', sourceId: featuredJournal._id.toString() })
    assert.equal(repeated.status, 200)
    assert.equal(repeated.body.highlight.id, created.body.highlight.id)
    assert.equal((await secondaryAgent.post('/api/journey/highlights').set('Origin', frontendOrigin).send({ sourceType: 'journal', sourceId: featuredJournal._id.toString() })).status, 404)

    const first = await primaryAgent.get('/api/journey/month/2024/3')
    const second = await primaryAgent.get('/api/journey/month/2024/3')
    assert.deepEqual(first.body.previewDays.map((day: { date: string }) => day.date), second.body.previewDays.map((day: { date: string }) => day.date))
    assert.ok(first.body.previewDays.some((day: { date: string }) => day.date === '2024-03-30'))
    assert.equal(first.body.album.excerpt.date, '2024-03-30')
  })

  test('manual and automatic covers enforce owner, source and month then fall back safely', async () => {
    assert.equal((await primaryAgent.put('/api/journey/albums/2024/3').set('Origin', frontendOrigin).send({ title: 'Tháng của những đổi thay', coverImageId: taskImageId })).status, 400)
    assert.equal((await primaryAgent.put('/api/journey/albums/2024/3').set('Origin', frontendOrigin).send({ title: '', coverImageId: outsideImageId })).status, 400)
    assert.equal((await primaryAgent.put('/api/journey/albums/2024/3').set('Origin', frontendOrigin).send({ title: '', coverImageId: secondaryImageId })).status, 400)

    const saved = await primaryAgent.put('/api/journey/albums/2024/3').set('Origin', frontendOrigin).send({ title: 'Tháng của những đổi thay', coverImageId: marchImageId })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.album.coverSource, 'manual')
    assert.equal(saved.body.album.selectedCoverImageId, marchImageId)
    assert.equal(saved.body.album.title, 'Tháng của những đổi thay')

    await MediaAsset.updateOne({ _id: marchImageId }, { $set: { status: 'deleting' } })
    const fallback = await primaryAgent.get('/api/journey/month/2024/3')
    assert.notEqual(fallback.body.album.coverSource, 'manual')
    assert.equal(fallback.body.album.selectedCoverImageId, null)
    await MediaAsset.updateOne({ _id: marchImageId }, { $set: { status: 'ready' } })

    const automatic = await primaryAgent.put('/api/journey/albums/2024/3').set('Origin', frontendOrigin).send({ title: '', coverImageId: null })
    assert.equal(automatic.status, 200)
    assert.equal(automatic.body.album.customTitle, '')
    assert.equal(automatic.body.album.coverSource, 'automatic')
  })

  test('day lists paginate without duplicates and day detail returns full journal images only', async () => {
    const first = await primaryAgent.get('/api/journey/days?from=2024-03-01&to=2024-03-31&page=1&limit=3')
    const second = await primaryAgent.get('/api/journey/days?from=2024-03-01&to=2024-03-31&page=2&limit=3')
    assert.equal(first.status, 200)
    assert.equal(first.body.pagination.total, 8)
    assert.equal(second.status, 200)
    const dates = [...first.body.days, ...second.body.days].map((day: { date: string }) => day.date)
    assert.equal(new Set(dates).size, 6)

    const day = await primaryAgent.get('/api/journey/days/2024-03-18')
    assert.equal(day.status, 200)
    assert.equal(day.body.entry.images.length, 2)
    assert.equal(day.body.entry.content, '')
    assert.equal('task' in day.body.entry, false)
    assert.equal((await primaryAgent.get('/api/journey/days/2024-03-19')).body.entry, null)
  })

  test('phase covers use journal images in range and long phases paginate without a 366-day cap', async () => {
    const rejected = await primaryAgent.post('/api/journey/phases').set('Origin', frontendOrigin).send({
      name: 'Ảnh task không hợp lệ', startDate: '2024-03-01', endDate: '2024-03-31', coverImageId: taskImageId, introduction: '', summary: '',
    })
    assert.equal(rejected.status, 400)
    const created = await primaryAgent.post('/api/journey/phases').set('Origin', frontendOrigin).send({
      name: 'Một hành trình dài', startDate: '2023-01-01', endDate: '2025-12-31', coverImageId: marchImageId, introduction: 'Mở đầu.', summary: 'Tổng kết.',
    })
    assert.equal(created.status, 201)
    assert.equal(created.body.phase.coverImage.id, marchImageId)
    const phaseId = created.body.phase.id as string
    const days = await primaryAgent.get(`/api/journey/phases/${phaseId}/days?page=1&limit=3`)
    assert.equal(days.status, 200)
    assert.equal(days.body.pagination.limit, 3)
    assert.ok(days.body.pagination.total >= 10)
    assert.equal((await secondaryAgent.get(`/api/journey/phases/${phaseId}/days`)).status, 404)
    assert.equal((await secondaryAgent.patch(`/api/journey/phases/${phaseId}`).set('Origin', frontendOrigin).send({ summary: 'Không được sửa' })).status, 404)
  })

  test('cover picker is journal-only, paginated and owner scoped', async () => {
    const covers = await primaryAgent.get('/api/journey/covers?from=2024-03-01&to=2024-03-31&page=1&limit=1')
    assert.equal(covers.status, 200)
    assert.equal(covers.body.pagination.total, 2)
    assert.equal(covers.body.images.length, 1)
    assert.equal(JSON.stringify(covers.body).includes(taskImageId), false)
    const isolated = await secondaryAgent.get('/api/journey/covers?from=2024-03-01&to=2024-03-31')
    assert.equal(isolated.body.pagination.total, 1)
  })

  test('deleting a journal removes its highlight and invalidates album or phase references without touching tasks', async () => {
    const journal = await Journal.findOne({ userId: primaryUserId, date: '2024-03-18' })
    assert.ok(journal)
    const highlight = await primaryAgent.post('/api/journey/highlights').set('Origin', frontendOrigin).send({ sourceType: 'journal', sourceId: journal._id.toString() })
    assert.ok([200, 201].includes(highlight.status))
    await primaryAgent.put('/api/journey/albums/2024/3').set('Origin', frontendOrigin).send({ title: '', coverImageId: marchImageId })
    const phase = await JourneyPhase.findOne({ userId: primaryUserId, coverImageId: marchImageId })
    assert.ok(phase)

    const deletion = await primaryAgent.delete('/api/journals/2024-03-18').set('Origin', frontendOrigin).send({ version: journal.version })
    assert.ok([200, 202, 204].includes(deletion.status))
    assert.equal(await JourneyHighlight.countDocuments({ userId: primaryUserId, sourceId: journal._id }), 0)
    assert.equal((await JourneyAlbum.findOne({ userId: primaryUserId, year: 2024, month: 3 }))?.coverImageId, null)
    assert.equal((await JourneyPhase.findById(phase._id))?.coverImageId, null)
    assert.equal(await Task.countDocuments({ _id: taskId, userId: primaryUserId }), 1)
  })
})
