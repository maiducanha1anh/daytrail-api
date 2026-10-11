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
import { createR2MediaStorage, type MediaStorage } from '../media/storage.js'
import { Profile } from '../models/Profile.js'
import { ProfileImage } from '../models/ProfileImage.js'
import { ensureDatabaseIndexes } from '../models/indexes.js'
import { Session } from '../models/Session.js'
import { User } from '../models/User.js'

const frontendOrigin = 'http://localhost:5173'
const runId = randomUUID().replaceAll('-', '')
const testDomain = `${runId}.profile.test`
const validPassword = 'MatKhauAnh!12345'
let app: Express
let storage: MediaStorage
let keyPrefix = ''
let primaryAgent: ReturnType<typeof request.agent>
let secondaryAgent: ReturnType<typeof request.agent>
let primaryUserId = ''
let sampleImage: Buffer

function testApp(mediaStorage: MediaStorage, mediaKeyPrefix: string) {
  return createApp({
    authRateLimitMax: 100, authRateLimitWindowMs: 60_000, cookieSecure: false, frontendOrigin,
    isDatabaseReady: () => pingDatabase(3_000), mediaKeyPrefix, mediaStorage,
    mediaUploadConcurrency: 20, sessionTtlMs: 7 * 24 * 60 * 60 * 1_000,
  })
}

async function registerAndLogin(agent: ReturnType<typeof request.agent>, email: string, displayName: string) {
  const registration = await agent.post('/api/auth/register').set('Origin', frontendOrigin).send({ displayName, email, password: validPassword })
  assert.equal(registration.status, 201)
  const login = await agent.post('/api/auth/login').set('Origin', frontendOrigin).send({ email, password: validPassword })
  assert.equal(login.status, 200)
  return registration.body.user.id as string
}

function uploadProfileImage(agent: ReturnType<typeof request.agent>, role: 'avatar' | 'decoration', clientUploadId = randomUUID(), caption = '') {
  return agent.post('/api/profile/images').set('Origin', frontendOrigin)
    .field('clientUploadId', clientUploadId).field('role', role).field('caption', caption)
    .attach('file', sampleImage, { filename: 'profile.png', contentType: 'image/png' })
}

function profileInput(overrides: Record<string, unknown> = {}) {
  return {
    about: 'Mình thích những chuyến đi và những trang sách.', aspiration: 'Sống cân bằng và học thêm điều mới.',
    avatarImageId: null, captions: {}, decorationImageIds: [], displayName: 'Minh Anh kiểm thử',
    tagline: 'Chậm lại để hiểu mình hơn.', version: 0, ...overrides,
  }
}

before(async () => {
  const config = loadTestConfig()
  const mediaConfig = loadTestMediaConfig(runId)
  assert.equal(config.databaseName, 'daytrail_test')
  assert.equal(mediaConfig.bucket, 'daytrail-media-test')
  assert.equal(mediaConfig.keyPrefix, `daytrail/test/${runId}`)
  keyPrefix = mediaConfig.keyPrefix
  storage = createR2MediaStorage(mediaConfig)
  await connectDatabase({ connectTimeoutMs: config.mongodbConnectTimeoutMs, databaseName: config.databaseName, pingTimeoutMs: config.mongodbPingTimeoutMs, uri: config.mongodbUri })
  assert.equal(mongoose.connection.name, 'daytrail_test')
  assert.deepEqual(await storage.listKeys(`${keyPrefix}/`), [])
  await ensureDatabaseIndexes()
  sampleImage = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#6f8a63' } }).png().withMetadata({ orientation: 6 }).toBuffer()
  app = testApp(storage, keyPrefix)
  primaryAgent = request.agent(app)
  secondaryAgent = request.agent(app)
  primaryUserId = await registerAndLogin(primaryAgent, `primary@${testDomain}`, 'Primary profile tester')
  await registerAndLogin(secondaryAgent, `secondary@${testDomain}`, 'Secondary profile tester')
})

after(async () => {
  if (mongoose.connection.readyState !== 1) return
  assert.equal(mongoose.connection.name, 'daytrail_test')
  const keys = await storage.listKeys(`${keyPrefix}/`)
  for (const key of keys) await storage.deleteObject(key)
  assert.deepEqual(await storage.listKeys(`${keyPrefix}/`), [])
  const users = await User.find({ email: { $regex: `@${testDomain.replaceAll('.', '\\.')}$` } }).select('_id')
  const userIds = users.map((user) => user._id)
  await ProfileImage.deleteMany({ userId: { $in: userIds } })
  await Profile.deleteMany({ userId: { $in: userIds } })
  await Session.deleteMany({ userId: { $in: userIds } })
  await User.deleteMany({ _id: { $in: userIds } })
  assert.equal(await ProfileImage.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await Profile.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await Session.countDocuments({ userId: { $in: userIds } }), 0)
  assert.equal(await User.countDocuments({ _id: { $in: userIds } }), 0)
  await disconnectDatabase()
})

describe('DayTrail private profile integration', { concurrency: 1 }, () => {
  test('default profile is private and validates Origin and allowed fields', async () => {
    assert.equal((await request(app).get('/api/profile')).status, 401)
    const initial = await primaryAgent.get('/api/profile')
    assert.equal(initial.status, 200)
    assert.equal(initial.body.profile.version, 0)
    assert.equal(initial.body.profile.avatar, null)
    assert.deepEqual(initial.body.profile.decorations, [])
    assert.equal(initial.body.profile.displayName, 'Primary profile tester')
    assert.equal((await primaryAgent.put('/api/profile').set('Origin', 'https://wrong.example').send(profileInput())).status, 403)
    assert.equal((await primaryAgent.put('/api/profile').set('Origin', frontendOrigin).send(profileInput({ email: 'blocked@example.test' }))).status, 400)
  })

  test('avatar upload is idempotent, private, normalized and persisted with the profile', { timeout: 120_000 }, async () => {
    const clientUploadId = randomUUID()
    const created = await uploadProfileImage(primaryAgent, 'avatar', clientUploadId)
    assert.equal(created.status, 201)
    assert.equal(created.body.image.mimeType, 'image/webp')
    assert.equal(created.body.image.fullWidth, 80)
    assert.equal(created.body.image.fullHeight, 120)
    const imageId = created.body.image.id as string
    const retried = await uploadProfileImage(primaryAgent, 'avatar', clientUploadId)
    assert.equal(retried.status, 200)
    assert.equal(retried.body.image.id, imageId)
    assert.equal(await ProfileImage.countDocuments({ userId: primaryUserId, clientUploadId }), 1)
    assert.equal((await request(app).get(`/api/profile/images/${imageId}/file?variant=full`)).status, 401)
    assert.equal((await secondaryAgent.get(`/api/profile/images/${imageId}/file?variant=full`)).status, 404)
    const file = await primaryAgent.get(`/api/profile/images/${imageId}/file?variant=full`)
    assert.equal(file.status, 200)
    assert.equal(file.headers['cache-control'], 'private, no-store')
    const metadata = await sharp(file.body as Buffer).metadata()
    assert.equal(metadata.format, 'webp')
    assert.equal(metadata.orientation, undefined)
    assert.equal(metadata.exif, undefined)
    const saved = await primaryAgent.put('/api/profile').set('Origin', frontendOrigin).send(profileInput({ avatarImageId: imageId, captions: { [imageId]: 'Ảnh đại diện riêng tư' } }))
    assert.equal(saved.status, 200)
    assert.equal(saved.body.profile.version, 1)
    assert.equal(saved.body.profile.avatar.id, imageId)
    assert.equal(saved.body.profile.avatar.caption, 'Ảnh đại diện riêng tư')
    const me = await primaryAgent.get('/api/auth/me')
    assert.equal(me.status, 200)
    assert.equal(me.body.user.displayName, 'Minh Anh kiểm thử')
    assert.equal((await ProfileImage.findById(imageId))?.attached, true)
  })

  test('version conflicts do not overwrite another tab and owner fields cannot be changed', async () => {
    const stale = await primaryAgent.put('/api/profile').set('Origin', frontendOrigin).send(profileInput({ about: 'Bản cũ không được ghi đè.', version: 0 }))
    assert.equal(stale.status, 409)
    const current = await primaryAgent.get('/api/profile')
    assert.equal(current.status, 200)
    assert.equal(current.body.profile.about, 'Mình thích những chuyến đi và những trang sách.')
    assert.equal((await primaryAgent.put('/api/profile').set('Origin', frontendOrigin).send(profileInput({ userId: primaryUserId, version: 1 }))).status, 400)
  })

  test('four decorations persist in order while a fifth is rejected', { timeout: 120_000 }, async () => {
    const current = await primaryAgent.get('/api/profile')
    const avatarImageId = current.body.profile.avatar.id as string
    const ids: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const upload = await uploadProfileImage(primaryAgent, 'decoration', randomUUID(), `Ảnh ${index + 1}`)
      assert.equal(upload.status, 201)
      ids.push(upload.body.image.id as string)
    }
    assert.equal((await primaryAgent.put('/api/profile').set('Origin', frontendOrigin).send(profileInput({ avatarImageId, decorationImageIds: ids, version: 1 }))).status, 400)
    const selected = ids.slice(0, 4)
    const saved = await primaryAgent.put('/api/profile').set('Origin', frontendOrigin).send(profileInput({
      avatarImageId, captions: Object.fromEntries(selected.map((id, index) => [id, `Kỷ niệm ${index + 1}`])), decorationImageIds: selected, version: 1,
    }))
    assert.equal(saved.status, 200)
    assert.equal(saved.body.profile.version, 2)
    assert.deepEqual(saved.body.profile.decorations.map((image: { id: string }) => image.id), selected)
    const discarded = await primaryAgent.post('/api/profile/images/discard').set('Origin', frontendOrigin).send({ imageIds: [ids[4]] })
    assert.ok([200, 202].includes(discarded.status))
    assert.equal(await ProfileImage.exists({ _id: ids[4] }), null)
  })

  test('replacing selected images removes old private objects only after a successful save', { timeout: 120_000 }, async () => {
    const before = await primaryAgent.get('/api/profile')
    const oldAvatarId = before.body.profile.avatar.id as string
    const oldKeys = await ProfileImage.findById(oldAvatarId).select('objectKeyFull objectKeyThumbnail')
    assert.ok(oldKeys)
    const replacement = await uploadProfileImage(primaryAgent, 'avatar')
    assert.equal(replacement.status, 201)
    const replacementId = replacement.body.image.id as string
    const decorations = before.body.profile.decorations.map((image: { id: string }) => image.id)
    const failed = await primaryAgent.put('/api/profile').set('Origin', frontendOrigin).send(profileInput({ avatarImageId: replacementId, decorationImageIds: decorations, version: 1 }))
    assert.equal(failed.status, 409)
    assert.ok(await ProfileImage.exists({ _id: oldAvatarId }))
    const saved = await primaryAgent.put('/api/profile').set('Origin', frontendOrigin).send(profileInput({ avatarImageId: replacementId, decorationImageIds: decorations, version: before.body.profile.version }))
    assert.equal(saved.status, 200)
    assert.equal(saved.body.profile.avatar.id, replacementId)
    assert.equal(await ProfileImage.exists({ _id: oldAvatarId }), null)
    assert.equal((await storage.listKeys(oldKeys.objectKeyFull)).length, 0)
    assert.equal((await storage.listKeys(oldKeys.objectKeyThumbnail)).length, 0)
  })
})
