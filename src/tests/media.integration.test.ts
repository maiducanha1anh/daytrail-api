import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import type { Express } from 'express'
import mongoose from 'mongoose'
import sharp from 'sharp'
import request from 'supertest'
import { createApp } from '../app.js'
import { loadTestConfig, loadTestMediaConfig } from '../config/env.js'
import { connectDatabase, disconnectDatabase, pingDatabase } from '../database/mongoose.js'
import { MediaTooLargeError } from '../media/errors.js'
import { MEDIA_MAX_FILE_BYTES, processImage } from '../media/image.js'
import { processCleanupJobs, uploadMedia } from '../media/service.js'
import {
  createR2MediaStorage,
  MediaStorageOperationError,
  type MediaStorage,
  type StoredMediaObject,
} from '../media/storage.js'
import { Journal } from '../models/Journal.js'
import { MediaAsset } from '../models/MediaAsset.js'
import { ensureDatabaseIndexes } from '../models/indexes.js'
import { Session } from '../models/Session.js'
import { Task } from '../models/Task.js'
import { TaskSeries } from '../models/TaskSeries.js'
import { User } from '../models/User.js'
import { deleteTask } from '../tasks/service.js'

const frontendOrigin = 'http://localhost:5173'
const runId = randomUUID().replaceAll('-', '')
const testDomain = `${runId}.stage4c1.test`
const validPassword = 'MatKhauAnh!12345'
let app: Express
let noStorageApp: Express
let storage: MediaStorage
let keyPrefix = ''
let pingTimeoutMs = 3_000
let primaryAgent: ReturnType<typeof request.agent>
let secondaryAgent: ReturnType<typeof request.agent>
let noStorageAgent: ReturnType<typeof request.agent>
let primaryUserId = ''
let sampleJpeg: Buffer
let samplePng: Buffer
let sampleGif: Buffer
let tinyWebp: Buffer

function createTestApp(mediaStorage?: MediaStorage, mediaKeyPrefix?: string) {
  return createApp({
    authRateLimitMax: 100,
    authRateLimitWindowMs: 60_000,
    cookieSecure: false,
    frontendOrigin,
    isDatabaseReady: () => pingDatabase(pingTimeoutMs),
    mediaKeyPrefix,
    mediaStorage,
    mediaUploadConcurrency: 20,
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

async function createTask(agent: ReturnType<typeof request.agent>, name = 'Task with private image') {
  const result = await agent.post('/api/tasks').set('Origin', frontendOrigin).send({
    date: '2026-10-06',
    name,
    startTime: '09:00',
    endTime: '10:00',
    repeat: 'none',
  })
  assert.equal(result.status, 201)
  return result.body.task.id as string
}

function uploadTaskImage(
  agent: ReturnType<typeof request.agent>,
  taskId: string,
  file: Buffer,
  caption = '',
  uploadId: string = randomUUID(),
) {
  return agent
    .post(`/api/tasks/${taskId}/images`)
    .set('Origin', frontendOrigin)
    .field('clientUploadId', uploadId)
    .field('caption', caption)
    .attach('file', file, { filename: 'image.jpg', contentType: 'image/jpeg' })
}

function uploadJournalImage(
  agent: ReturnType<typeof request.agent>,
  date: string,
  file: Buffer,
  version: number | null,
  caption = '',
  uploadId: string = randomUUID(),
) {
  return agent
    .post(`/api/journals/${date}/images`)
    .set('Origin', frontendOrigin)
    .field('clientUploadId', uploadId)
    .field('caption', caption)
    .field('version', version === null ? 'null' : String(version))
    .attach('file', file, { filename: 'image.png', contentType: 'image/png' })
}

class FailDeleteOnceStorage implements MediaStorage {
  private failures = 1
  constructor(private readonly delegate: MediaStorage) {}
  deleteObject(key: string) {
    if (this.failures > 0) {
      this.failures -= 1
      return Promise.reject(new MediaStorageOperationError('InjectedDeleteFailure'))
    }
    return this.delegate.deleteObject(key)
  }
  getObject(key: string): Promise<StoredMediaObject> {
    return this.delegate.getObject(key)
  }
  listKeys(prefix: string): Promise<string[]> {
    return this.delegate.listKeys(prefix)
  }
  putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    return this.delegate.putObject(key, body, contentType)
  }
}

class FailSecondPutStorage implements MediaStorage {
  private puts = 0
  constructor(private readonly delegate: MediaStorage) {}
  deleteObject(key: string): Promise<void> {
    return this.delegate.deleteObject(key)
  }
  getObject(key: string): Promise<StoredMediaObject> {
    return this.delegate.getObject(key)
  }
  listKeys(prefix: string): Promise<string[]> {
    return this.delegate.listKeys(prefix)
  }
  async putObject(key: string, body: Buffer, contentType: string) {
    this.puts += 1
    if (this.puts === 2) throw new MediaStorageOperationError('InjectedSecondPutFailure')
    await this.delegate.putObject(key, body, contentType)
  }
}

class BlockingFirstPutStorage implements MediaStorage {
  private blocked = true
  private readonly releasePromise: Promise<void>
  private releaseUpload!: () => void
  private readonly startedPromise: Promise<void>
  private markStarted!: () => void
  constructor(private readonly delegate: MediaStorage) {
    this.releasePromise = new Promise((resolve) => {
      this.releaseUpload = resolve
    })
    this.startedPromise = new Promise((resolve) => {
      this.markStarted = resolve
    })
  }
  waitUntilStarted() {
    return this.startedPromise
  }
  release() {
    this.releaseUpload()
  }
  deleteObject(key: string): Promise<void> {
    return this.delegate.deleteObject(key)
  }
  getObject(key: string): Promise<StoredMediaObject> {
    return this.delegate.getObject(key)
  }
  listKeys(prefix: string): Promise<string[]> {
    return this.delegate.listKeys(prefix)
  }
  async putObject(key: string, body: Buffer, contentType: string) {
    if (this.blocked) {
      this.blocked = false
      this.markStarted()
      await this.releasePromise
    }
    await this.delegate.putObject(key, body, contentType)
  }
}

before(async () => {
  const config = loadTestConfig()
  const mediaConfig = loadTestMediaConfig(runId)
  assert.equal(config.databaseName, 'daytrail_test')
  assert.equal(mediaConfig.bucket, 'daytrail-media-test')
  assert.equal(mediaConfig.keyPrefix, `daytrail/test/${runId}`)
  pingTimeoutMs = config.mongodbPingTimeoutMs
  keyPrefix = mediaConfig.keyPrefix
  storage = createR2MediaStorage(mediaConfig)
  await connectDatabase({
    connectTimeoutMs: config.mongodbConnectTimeoutMs,
    databaseName: config.databaseName,
    pingTimeoutMs: config.mongodbPingTimeoutMs,
    uri: config.mongodbUri,
  })
  assert.equal(mongoose.connection.name, 'daytrail_test')
  assert.deepEqual(await storage.listKeys(`${keyPrefix}/`), [])
  await ensureDatabaseIndexes()

  sampleJpeg = await sharp({
    create: { width: 80, height: 40, channels: 3, background: '#78b84d' },
  }).jpeg().withMetadata({ orientation: 6 }).toBuffer()
  samplePng = await sharp({
    create: { width: 64, height: 48, channels: 4, background: { r: 42, g: 82, b: 58, alpha: 0.8 } },
  }).png().toBuffer()
  sampleGif = await sharp({
    create: { width: 10, height: 10, channels: 3, background: '#ff0000' },
  }).gif().toBuffer()
  tinyWebp = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#d7ef9b' },
  }).webp().toBuffer()

  app = createTestApp(storage, keyPrefix)
  noStorageApp = createTestApp()
  primaryAgent = request.agent(app)
  secondaryAgent = request.agent(app)
  noStorageAgent = request.agent(noStorageApp)
  primaryUserId = await registerAndLogin(primaryAgent, `primary@${testDomain}`, 'Primary media tester')
  await registerAndLogin(secondaryAgent, `secondary@${testDomain}`, 'Secondary media tester')
  await registerAndLogin(noStorageAgent, `nostorage@${testDomain}`, 'No storage tester')
})

after(async () => {
  if (mongoose.connection.readyState !== 1) return
  assert.equal(mongoose.connection.name, 'daytrail_test')
  const mediaConfig = loadTestMediaConfig(runId)
  assert.equal(mediaConfig.bucket, 'daytrail-media-test')
  assert.equal(mediaConfig.keyPrefix, keyPrefix)

  const keys = await storage.listKeys(`${keyPrefix}/`)
  for (const key of keys) await storage.deleteObject(key)
  assert.deepEqual(await storage.listKeys(`${keyPrefix}/`), [])

  const users = await User.find({ email: { $regex: `@${testDomain.replaceAll('.', '\\.')}$` } }).select('_id')
  const userIds = users.map((user) => user._id)
  if (userIds.length > 0) {
    await MediaAsset.deleteMany({ userId: { $in: userIds } })
    await Journal.deleteMany({ userId: { $in: userIds } })
    await Task.deleteMany({ userId: { $in: userIds } })
    await TaskSeries.deleteMany({ userId: { $in: userIds } })
    await Session.deleteMany({ userId: { $in: userIds } })
    await User.deleteMany({ _id: { $in: userIds } })
  }
  assert.equal(await MediaAsset.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await Journal.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await Task.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await TaskSeries.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await Session.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await User.countDocuments({ _id: { $in: userIds } }), 0)
  await disconnectDatabase()
})

describe('DayTrail private media integration', { concurrency: 1 }, () => {
  test('existing API stays available without R2 config while media routes return 503', async () => {
    assert.equal((await noStorageAgent.get('/api/health')).status, 200)
    assert.equal((await noStorageAgent.get('/api/ready')).status, 200)
    const taskId = await createTask(noStorageAgent, 'Task without configured storage')
    const list = await noStorageAgent.get(`/api/tasks/${taskId}/images`)
    assert.equal(list.status, 503)
    assert.equal(list.body.code, 'MEDIA_STORAGE_UNAVAILABLE')
    assert.equal((await request(noStorageApp).get(`/api/tasks/${taskId}/images`)).status, 401)
  })

  test('actual R2 task upload, idempotency, private read, caption, move and delete work', { timeout: 120_000 }, async () => {
    const taskId = await createTask(primaryAgent, 'Actual R2 lifecycle')
    const uploadId = randomUUID()
    const created = await uploadTaskImage(primaryAgent, taskId, sampleJpeg, '  Chú thích\nriêng tư  ', uploadId)
    assert.equal(created.status, 201)
    assert.equal(created.body.image.caption, '  Chú thích\nriêng tư  ')
    assert.equal(created.body.image.mimeType, 'image/webp')
    assert.equal(created.body.image.fullWidth, 40)
    assert.equal(created.body.image.fullHeight, 80)
    const imageId = created.body.image.id as string

    const retry = await uploadTaskImage(primaryAgent, taskId, sampleJpeg, '  Chú thích\nriêng tư  ', uploadId)
    assert.equal(retry.status, 200)
    assert.equal(retry.body.image.id, imageId)
    assert.equal((await uploadTaskImage(primaryAgent, taskId, sampleJpeg, 'Payload changed', uploadId)).status, 409)
    assert.equal(await MediaAsset.countDocuments({ userId: primaryUserId, ownerKey: taskId, status: 'ready' }), 1)

    const list = await primaryAgent.get(`/api/tasks/${taskId}/images`)
    assert.equal(list.status, 200)
    assert.equal(list.body.images.length, 1)
    assert.equal((await request(app).get(`/api/images/${imageId}/file?variant=full`)).status, 401)
    assert.equal((await secondaryAgent.get(`/api/images/${imageId}/file?variant=full`)).status, 404)

    const full = await primaryAgent.get(`/api/images/${imageId}/file?variant=full`)
    assert.equal(full.status, 200)
    assert.match(full.headers['content-type'], /^image\/webp/)
    assert.equal(full.headers['cache-control'], 'private, no-store')
    assert.equal(full.headers['x-content-type-options'], 'nosniff')
    const metadata = await sharp(full.body as Buffer).metadata()
    assert.equal(metadata.format, 'webp')
    assert.equal(metadata.orientation, undefined)
    assert.equal(metadata.exif, undefined)

    const thumbnail = await primaryAgent.get(`/api/images/${imageId}/file?variant=thumbnail`)
    assert.equal(thumbnail.status, 200)
    const thumbnailMetadata = await sharp(thumbnail.body as Buffer).metadata()
    assert.ok((thumbnailMetadata.width ?? 1) <= 480)
    assert.ok((thumbnailMetadata.height ?? 1) <= 480)

    const caption = await primaryAgent
      .patch(`/api/images/${imageId}`)
      .set('Origin', frontendOrigin)
      .send({ caption: 'Caption updated', version: 1 })
    assert.equal(caption.status, 200)
    assert.equal(caption.body.image.version, 2)
    assert.equal((await primaryAgent.patch(`/api/tasks/${taskId}/date`).set('Origin', frontendOrigin).send({ date: '2026-10-07' })).status, 200)
    assert.equal((await primaryAgent.get(`/api/images/${imageId}/file?variant=full`)).status, 200)

    const deleted = await primaryAgent
      .delete(`/api/images/${imageId}`)
      .set('Origin', frontendOrigin)
      .send({ version: 2 })
    assert.equal(deleted.status, 200)
    assert.equal(deleted.body.cleanupStatus, 'deleted')
    assert.equal((await primaryAgent.get(`/api/images/${imageId}/file?variant=full`)).status, 404)
    assert.equal((await storage.listKeys(`${keyPrefix}/${imageId}/`)).length, 0)
  })

  test('image-only journal uses aggregate version and deleting its last image removes the empty journal', { timeout: 120_000 }, async () => {
    const date = '2026-10-08'
    const created = await uploadJournalImage(primaryAgent, date, samplePng, null, 'Ảnh không cần nội dung')
    assert.equal(created.status, 201)
    assert.equal(created.body.journalVersion, 1)
    const imageId = created.body.image.id as string
    const journal = await primaryAgent.get(`/api/journals/${date}`)
    assert.equal(journal.status, 200)
    assert.equal(journal.body.journal.content, '')
    assert.equal(journal.body.journal.version, 1)

    const caption = await primaryAgent
      .patch(`/api/images/${imageId}`)
      .set('Origin', frontendOrigin)
      .send({ caption: 'Chú thích mới\n', version: 1, journalVersion: 1 })
    assert.equal(caption.status, 200)
    assert.equal(caption.body.image.caption, 'Chú thích mới\n')
    assert.equal(caption.body.journalVersion, 2)
    assert.equal((await primaryAgent.delete(`/api/images/${imageId}`).set('Origin', frontendOrigin).send({ version: 2, journalVersion: 1 })).status, 409)

    const deleted = await primaryAgent
      .delete(`/api/images/${imageId}`)
      .set('Origin', frontendOrigin)
      .send({ version: 2, journalVersion: 2 })
    assert.equal(deleted.status, 200)
    assert.equal(deleted.body.journalVersion, null)
    assert.deepEqual((await primaryAgent.get(`/api/journals/${date}`)).body, { journal: null })
  })

  test('upload validates authentication, Origin, multipart fields, bytes, formats and resource limits', { timeout: 120_000 }, async () => {
    const taskId = await createTask(primaryAgent, 'Validation task')
    assert.equal((await request(app).post(`/api/tasks/${taskId}/images`).set('Origin', frontendOrigin)).status, 401)
    assert.equal((await primaryAgent.post(`/api/tasks/${taskId}/images`).set('Origin', frontendOrigin).send({})).status, 415)
    assert.equal((await primaryAgent
      .post(`/api/tasks/${taskId}/images`)
      .set('Origin', 'https://example.invalid')
      .field('clientUploadId', randomUUID())
      .attach('file', samplePng, 'image.png')).status, 403)
    assert.equal((await uploadTaskImage(primaryAgent, taskId, Buffer.from('not an image'))).status, 400)
    assert.equal((await uploadTaskImage(primaryAgent, taskId, sampleGif)).status, 415)
    assert.equal((await uploadTaskImage(primaryAgent, taskId, samplePng, 'x'.repeat(501))).status, 400)
    assert.equal((await uploadTaskImage(primaryAgent, taskId, samplePng, '', 'not-a-uuid')).status, 400)

    const oversized = await primaryAgent
      .post(`/api/tasks/${taskId}/images`)
      .set('Origin', frontendOrigin)
      .field('clientUploadId', randomUUID())
      .attach('file', Buffer.alloc(MEDIA_MAX_FILE_BYTES + 1), { filename: 'too-large.jpg', contentType: 'image/jpeg' })
    assert.equal(oversized.status, 413)

    const tooManyPixels = await sharp({
      create: { width: 5_000, height: 4_001, channels: 3, background: '#ffffff' },
    }).jpeg({ quality: 20 }).toBuffer()
    await assert.rejects(() => processImage(tooManyPixels), MediaTooLargeError)
    assert.equal(await MediaAsset.countDocuments({ ownerKey: taskId }), 0)
  })

  test('concurrent uploads enforce the 12-image quota and parent deletion cleans exact R2 objects', { timeout: 180_000 }, async () => {
    const taskId = await createTask(primaryAgent, 'Concurrent quota task')
    const firstBatch = await Promise.all(Array.from({ length: 6 }, () => uploadTaskImage(primaryAgent, taskId, tinyWebp)))
    const secondBatch = await Promise.all(Array.from({ length: 5 }, () => uploadTaskImage(primaryAgent, taskId, tinyWebp)))
    const finalConcurrentPair = await Promise.all(Array.from({ length: 2 }, () => uploadTaskImage(primaryAgent, taskId, tinyWebp)))
    const uploads = [...firstBatch, ...secondBatch, ...finalConcurrentPair]
    const statuses = uploads.map((item) => item.status).sort((left, right) => left - right)
    assert.deepEqual(statuses, [...Array.from({ length: 12 }, () => 201), 409])
    assert.equal(await MediaAsset.countDocuments({ userId: primaryUserId, ownerKey: taskId, status: 'ready' }), 12)
    const deletion = await primaryAgent.delete(`/api/tasks/${taskId}`).set('Origin', frontendOrigin).send({})
    assert.ok([200, 202].includes(deletion.status))
    if (deletion.status === 202) {
      await MediaAsset.updateMany({ ownerKey: taskId }, { $set: { nextCleanupAt: new Date(0) } })
      const cleaned = await processCleanupJobs(storage, 20)
      assert.equal(cleaned.failed, 0)
    }
    assert.equal(await MediaAsset.countDocuments({ ownerKey: taskId }), 0)
  })

  test('partial upload failure is compensated and delete failure remains in the durable retry queue', { timeout: 120_000 }, async () => {
    const uploadFailureAgent = request.agent(createTestApp(new FailSecondPutStorage(storage), keyPrefix))
    await registerAndLogin(uploadFailureAgent, `uploadfail@${testDomain}`, 'Upload failure tester')
    const uploadFailureTask = await createTask(uploadFailureAgent, 'Partial upload failure')
    const uploadFailure = await uploadTaskImage(uploadFailureAgent, uploadFailureTask, samplePng)
    assert.equal(uploadFailure.status, 503)
    assert.equal(uploadFailure.body.code, 'MEDIA_STORAGE_UNAVAILABLE')
    assert.equal(await MediaAsset.countDocuments({ ownerKey: uploadFailureTask }), 0)

    const failingDeleteStorage = new FailDeleteOnceStorage(storage)
    const failingDeleteAgent = request.agent(createTestApp(failingDeleteStorage, keyPrefix))
    await registerAndLogin(failingDeleteAgent, `deletefail@${testDomain}`, 'Delete failure tester')
    const deleteTaskId = await createTask(failingDeleteAgent, 'Durable delete retry')
    const uploaded = await uploadTaskImage(failingDeleteAgent, deleteTaskId, samplePng)
    assert.equal(uploaded.status, 201)
    const imageId = uploaded.body.image.id as string
    const deletion = await failingDeleteAgent
      .delete(`/api/images/${imageId}`)
      .set('Origin', frontendOrigin)
      .send({ version: 1 })
    assert.equal(deletion.status, 202)
    const queued = await MediaAsset.findById(imageId)
    assert.equal(queued?.status, 'cleanup_failed')
    assert.equal(queued?.lastCleanupCode, 'InjectedDeleteFailure')
    await MediaAsset.updateOne({ _id: imageId }, { $set: { nextCleanupAt: new Date(0) } })
    const retried = await processCleanupJobs(storage)
    assert.equal(retried.cleaned, 1)
    assert.equal(retried.failed, 0)
    assert.equal(await MediaAsset.exists({ _id: imageId }), null)
  })

  test('deleting an owner during upload cannot reactivate an image or leave an empty journal', { timeout: 120_000 }, async () => {
    const taskId = await createTask(primaryAgent, 'Delete during upload')
    const blocker = new BlockingFirstPutStorage(storage)
    const pending = uploadMedia(blocker, {
      caption: '',
      clientUploadId: randomUUID(),
      file: samplePng,
      keyPrefix,
      ownerKey: taskId,
      ownerType: 'task',
      userId: primaryUserId,
    })
    await blocker.waitUntilStarted()
    const deletedTask = await deleteTask(primaryUserId, taskId)
    assert.equal(deletedTask.queuedCount, 1)
    blocker.release()
    await assert.rejects(pending)
    assert.equal(await Task.exists({ _id: taskId }), null)
    assert.equal(await MediaAsset.countDocuments({ ownerKey: taskId }), 0)

    const date = '2026-10-09'
    const first = await uploadJournalImage(primaryAgent, date, samplePng, null)
    assert.equal(first.status, 201)
    const journalBlocker = new BlockingFirstPutStorage(storage)
    const pendingJournalUpload = uploadMedia(journalBlocker, {
      caption: '',
      clientUploadId: randomUUID(),
      file: samplePng,
      journalVersion: 1,
      keyPrefix,
      ownerKey: date,
      ownerType: 'journal',
      userId: primaryUserId,
    })
    await journalBlocker.waitUntilStarted()
    const deletedImage = await primaryAgent
      .delete(`/api/images/${first.body.image.id}`)
      .set('Origin', frontendOrigin)
      .send({ version: 1, journalVersion: 1 })
    assert.equal(deletedImage.status, 200)
    journalBlocker.release()
    await assert.rejects(pendingJournalUpload)
    assert.equal(await Journal.exists({ userId: primaryUserId, date }), null)
    assert.equal(await MediaAsset.countDocuments({ ownerKey: date }), 0)
  })

  test('stopping a recurring series retains an occurrence that has an image', { timeout: 120_000 }, async () => {
    const series = await primaryAgent.post('/api/tasks/series').set('Origin', frontendOrigin).send({
      date: '2026-11-01',
      name: 'Recurring image task',
      startTime: '09:00',
      endTime: '10:00',
      priority: 'normal',
      repeat: { frequency: 'daily', endDate: '2026-11-03' },
    })
    assert.equal(series.status, 201)
    const tasks = await primaryAgent.get('/api/tasks?from=2026-11-01&to=2026-11-03&page=1&limit=100')
    const occurrence = tasks.body.tasks.find((task: { recurrence?: { originalDate?: string } }) => task.recurrence?.originalDate === '2026-11-02')
    assert.ok(occurrence)
    assert.equal((await uploadTaskImage(primaryAgent, occurrence.id, samplePng)).status, 201)
    const stopped = await primaryAgent
      .post(`/api/tasks/series/${series.body.series.id}/stop`)
      .set('Origin', frontendOrigin)
      .send({ fromDate: '2026-11-01' })
    assert.equal(stopped.status, 200)
    assert.equal(stopped.body.keptCount, 1)
    assert.equal(stopped.body.removedCount, 2)
    assert.equal((await primaryAgent.get(`/api/tasks/${occurrence.id}`)).status, 200)
    const deletion = await primaryAgent.delete(`/api/tasks/${occurrence.id}`).set('Origin', frontendOrigin).send({})
    assert.ok([200, 202].includes(deletion.status))
  })
})
