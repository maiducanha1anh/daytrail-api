import mongoose, { type ClientSession, Types } from 'mongoose'
import { Journal } from '../models/Journal.js'
import { MediaAsset, type MediaAssetDocument, type MediaOwnerType } from '../models/MediaAsset.js'
import { Task } from '../models/Task.js'
import {
  MediaConflictError,
  MediaInputError,
  MediaNotFoundError,
  MediaStorageUnavailableError,
} from './errors.js'
import { mediaPayloadHash, processImage, type ProcessedImage } from './image.js'
import { MediaStorageOperationError, type MediaStorage } from './storage.js'
import { MEDIA_MAX_IMAGES_PER_OWNER, type DeleteMediaInput, type UpdateCaptionInput } from './validation.js'

const ACTIVE_STATUSES = ['uploading', 'ready'] as const
const CLEANUP_STATUSES = ['deleting', 'cleanup_failed'] as const
const STALE_UPLOAD_MS = 15 * 60 * 1_000
const UPLOAD_DELETE_GRACE_MS = 60_000

type UploadMediaInput = {
  caption: string
  clientUploadId: string
  file: Buffer
  journalVersion?: number | null
  keyPrefix: string
  ownerKey: string
  ownerType: MediaOwnerType
  userId: string
}

type CleanupResult = {
  cleaned: number
  failed: number
}

function ownerId(userId: string) {
  return new Types.ObjectId(userId)
}

function isDuplicateKeyError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000)
}

function publicMedia(media: MediaAssetDocument) {
  return {
    id: media._id.toString(),
    byteSize: media.byteSize,
    caption: media.caption,
    createdAt: media.createdAt.toISOString(),
    fullHeight: media.fullHeight,
    fullUrl: `/api/images/${media._id.toString()}/file?variant=full`,
    fullWidth: media.fullWidth,
    mimeType: media.mimeType,
    thumbnailHeight: media.thumbnailHeight,
    thumbnailUrl: `/api/images/${media._id.toString()}/file?variant=thumbnail`,
    thumbnailWidth: media.thumbnailWidth,
    updatedAt: media.updatedAt.toISOString(),
    version: media.version,
  }
}

function cleanupCode(error: unknown) {
  if (error instanceof MediaStorageOperationError) return error.safeCode
  return error instanceof Error ? error.name : 'UnknownError'
}

function storageUnavailable(error: unknown): never {
  if (error instanceof MediaStorageOperationError) throw new MediaStorageUnavailableError(`Kho ảnh tạm thời không sẵn sàng (${error.safeCode}).`)
  throw error
}

async function verifyOwner(
  session: ClientSession,
  userId: Types.ObjectId,
  ownerType: MediaOwnerType,
  ownerKey: string,
  journalVersion: number | null | undefined,
) {
  if (ownerType === 'task') {
    if (journalVersion !== undefined) throw new MediaInputError('Không gửi version nhật ký cho ảnh công việc.')
    if (!await Task.exists({ _id: ownerKey, userId }).session(session)) throw new MediaNotFoundError('Không tìm thấy công việc.')
    return
  }
  if (journalVersion === undefined) throw new MediaInputError('version là bắt buộc cho ảnh nhật ký.')
  if (journalVersion === null) {
    if (await Journal.exists({ userId, date: ownerKey }).session(session)) {
      throw new MediaConflictError('Nhật ký ngày này đã thay đổi. Hãy tải lại trước khi thêm ảnh.')
    }
    return
  }
  if (await Journal.exists({ userId, date: ownerKey, version: journalVersion }).session(session)) return
  if (await Journal.exists({ userId, date: ownerKey }).session(session)) {
    throw new MediaConflictError('Nhật ký đã thay đổi ở nơi khác. Hãy tải lại trước khi thêm ảnh.')
  }
  throw new MediaNotFoundError('Không tìm thấy nhật ký.')
}

async function reserveUpload(input: UploadMediaInput, processed: ProcessedImage, payloadHash: string) {
  const userId = ownerId(input.userId)
  for (let attempt = 0; attempt < MEDIA_MAX_IMAGES_PER_OWNER + 1; attempt += 1) {
    const session = await mongoose.startSession()
    try {
      const result = await session.withTransaction(async () => {
        const existing = await MediaAsset.findOne({
          clientUploadId: input.clientUploadId,
          ownerKey: input.ownerKey,
          ownerType: input.ownerType,
          userId,
        }).session(session)
        if (existing) {
          if (existing.payloadHash !== payloadHash) {
            throw new MediaConflictError('clientUploadId đã được dùng với file hoặc chú thích khác.')
          }
          if (existing.status === 'ready') return { existing, reserved: false }
          throw new MediaConflictError('Upload với clientUploadId này đang xử lý hoặc đang được dọn. Hãy chờ rồi thử lại.')
        }

        await verifyOwner(session, userId, input.ownerType, input.ownerKey, input.journalVersion)
        const used = await MediaAsset.find({ userId, ownerType: input.ownerType, ownerKey: input.ownerKey })
          .select('quotaSlot')
          .session(session)
        const occupied = new Set(used.map((item) => item.quotaSlot))
        const quotaSlot = Array.from({ length: MEDIA_MAX_IMAGES_PER_OWNER }, (_value, index) => index)
          .find((slot) => !occupied.has(slot))
        if (quotaSlot === undefined) throw new MediaConflictError(`Mỗi công việc hoặc nhật ký chỉ được tối đa ${MEDIA_MAX_IMAGES_PER_OWNER} ảnh.`)
        const mediaId = new Types.ObjectId()
        const objectBase = `${input.keyPrefix}/${mediaId.toString()}`
        const [media] = await MediaAsset.create([{
          _id: mediaId,
          byteSize: processed.full.length,
          caption: input.caption,
          clientUploadId: input.clientUploadId,
          fullHeight: processed.fullHeight,
          fullWidth: processed.fullWidth,
          mimeType: 'image/webp',
          objectKeyFull: `${objectBase}/full.webp`,
          objectKeyThumbnail: `${objectBase}/thumbnail.webp`,
          ownerKey: input.ownerKey,
          ownerType: input.ownerType,
          payloadHash,
          quotaSlot,
          status: 'uploading',
          thumbnailByteSize: processed.thumbnail.length,
          thumbnailHeight: processed.thumbnailHeight,
          thumbnailWidth: processed.thumbnailWidth,
          userId,
        }], { session })
        if (!media) throw new Error('Media upload reservation was not created')
        return { existing: media, reserved: true }
      })
      if (!result) throw new Error('Media upload reservation transaction returned no result')
      return result
    } catch (error: unknown) {
      if (isDuplicateKeyError(error) && attempt < MEDIA_MAX_IMAGES_PER_OWNER) continue
      throw error
    } finally {
      await session.endSession()
    }
  }
  throw new MediaConflictError('Không thể giữ chỗ upload ảnh do có request đồng thời. Hãy thử lại.')
}

async function activateUpload(mediaId: Types.ObjectId, input: UploadMediaInput) {
  const userId = ownerId(input.userId)
  const session = await mongoose.startSession()
  try {
    const result = await session.withTransaction(async () => {
      const media = await MediaAsset.findOne({ _id: mediaId, userId, status: 'uploading' }).session(session)
      if (!media) throw new MediaConflictError('Upload không còn hợp lệ vì đối tượng đã thay đổi hoặc bị xóa.')
      let journalVersion: number | undefined
      if (input.ownerType === 'task') {
        if (!await Task.exists({ _id: input.ownerKey, userId }).session(session)) throw new MediaNotFoundError('Không tìm thấy công việc.')
      } else if (input.journalVersion === null) {
        try {
          const [journal] = await Journal.create([{
            content: '',
            date: input.ownerKey,
            userId,
            version: 1,
          }], { session })
          if (!journal) throw new Error('Image-only journal was not created')
          journalVersion = journal.version
        } catch (error: unknown) {
          if (isDuplicateKeyError(error)) throw new MediaConflictError('Nhật ký ngày này đã thay đổi. Hãy tải lại trước khi thêm ảnh.')
          throw error
        }
      } else {
        const journal = await Journal.findOneAndUpdate(
          { userId, date: input.ownerKey, version: input.journalVersion },
          { $inc: { version: 1 } },
          { returnDocument: 'after', session },
        )
        if (!journal) {
          if (await Journal.exists({ userId, date: input.ownerKey }).session(session)) {
            throw new MediaConflictError('Nhật ký đã thay đổi ở nơi khác. Hãy tải lại trước khi thêm ảnh.')
          }
          throw new MediaNotFoundError('Không tìm thấy nhật ký.')
        }
        journalVersion = journal.version
      }
      media.status = 'ready'
      media.nextCleanupAt = null
      await media.save({ session })
      return { journalVersion, media }
    })
    if (!result) throw new Error('Media activation transaction returned no result')
    return result
  } finally {
    await session.endSession()
  }
}

async function queueCleanup(mediaId: Types.ObjectId, reason: string, delayMs = 0) {
  await MediaAsset.updateOne(
    { _id: mediaId, status: { $in: [...ACTIVE_STATUSES, ...CLEANUP_STATUSES] } },
    {
      $set: {
        cleanupReason: reason,
        nextCleanupAt: new Date(Date.now() + delayMs),
        status: 'deleting',
      },
    },
  )
}

async function cleanupAsset(storage: MediaStorage, media: MediaAssetDocument) {
  const results = await Promise.allSettled([
    storage.deleteObject(media.objectKeyFull),
    storage.deleteObject(media.objectKeyThumbnail),
  ])
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (!failure) {
    await MediaAsset.deleteOne({ _id: media._id, status: { $in: CLEANUP_STATUSES } })
    return true
  }
  const attempts = media.cleanupAttempts + 1
  const delayMs = Math.min(60 * 60 * 1_000, 5_000 * (2 ** Math.min(attempts - 1, 7)))
  await MediaAsset.updateOne(
    { _id: media._id, status: { $in: CLEANUP_STATUSES } },
    {
      $set: {
        lastCleanupCode: cleanupCode(failure.reason),
        nextCleanupAt: new Date(Date.now() + delayMs),
        status: 'cleanup_failed',
      },
      $inc: { cleanupAttempts: 1 },
    },
  )
  return false
}

export async function processCleanupJobs(storage: MediaStorage, limit = 20): Promise<CleanupResult> {
  const now = new Date()
  await MediaAsset.updateMany(
    { status: 'uploading', createdAt: { $lt: new Date(Date.now() - STALE_UPLOAD_MS) } },
    { $set: { cleanupReason: 'stale_upload', nextCleanupAt: now, status: 'deleting' } },
  )
  const jobs = await MediaAsset.find({
    status: { $in: CLEANUP_STATUSES },
    $or: [{ nextCleanupAt: null }, { nextCleanupAt: { $lte: now } }],
  }).sort({ nextCleanupAt: 1, createdAt: 1 }).limit(limit)
  let cleaned = 0
  let failed = 0
  for (const media of jobs) {
    if (await cleanupAsset(storage, media)) cleaned += 1
    else failed += 1
  }
  return { cleaned, failed }
}

export function startMediaCleanupWorker(storage: MediaStorage, intervalMs = 30_000) {
  let running = false
  const run = async () => {
    if (running) return
    running = true
    try {
      const result = await processCleanupJobs(storage)
      if (result.failed > 0) console.error(`Media cleanup retry pending (${result.failed})`)
    } catch (error: unknown) {
      console.error(`Media cleanup failed (${cleanupCode(error)})`)
    } finally {
      running = false
    }
  }
  void run()
  const timer = setInterval(() => void run(), intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}

export async function uploadMedia(storage: MediaStorage, input: UploadMediaInput) {
  const processed = await processImage(input.file)
  const payloadHash = mediaPayloadHash(input.file, input.caption)
  const reservation = await reserveUpload(input, processed, payloadHash)
  if (!reservation.reserved) {
    const journalVersion = input.ownerType === 'journal'
      ? (await Journal.findOne({ userId: ownerId(input.userId), date: input.ownerKey }).select('version'))?.version
      : undefined
    return { created: false, image: publicMedia(reservation.existing), journalVersion }
  }
  const media = reservation.existing
  try {
    await storage.putObject(media.objectKeyFull, processed.full, 'image/webp')
    await storage.putObject(media.objectKeyThumbnail, processed.thumbnail, 'image/webp')
  } catch (error: unknown) {
    await queueCleanup(media._id, 'upload_storage_failed').catch(() => undefined)
    const queued = await MediaAsset.findById(media._id)
    if (queued?.status === 'deleting') await cleanupAsset(storage, queued).catch(() => false)
    storageUnavailable(error)
  }

  try {
    const activated = await activateUpload(media._id, input)
    return {
      created: true,
      image: publicMedia(activated.media),
      journalVersion: activated.journalVersion,
    }
  } catch (error: unknown) {
    await queueCleanup(media._id, 'upload_activation_failed').catch(() => undefined)
    const queued = await MediaAsset.findById(media._id)
    if (queued?.status === 'deleting') await cleanupAsset(storage, queued).catch(() => false)
    throw error
  }
}

async function ensureCurrentOwner(media: MediaAssetDocument) {
  if (media.ownerType === 'task') {
    if (!await Task.exists({ _id: media.ownerKey, userId: media.userId })) throw new MediaNotFoundError('Không tìm thấy ảnh.')
  } else if (!await Journal.exists({ date: media.ownerKey, userId: media.userId })) {
    throw new MediaNotFoundError('Không tìm thấy ảnh.')
  }
}

export async function listMedia(userId: string, ownerType: MediaOwnerType, ownerKey: string) {
  const userIdValue = ownerId(userId)
  if (ownerType === 'task') {
    if (!await Task.exists({ _id: ownerKey, userId: userIdValue })) throw new MediaNotFoundError('Không tìm thấy công việc.')
  }
  const journal = ownerType === 'journal' ? await Journal.findOne({ date: ownerKey, userId: userIdValue }) : null
  const images = await MediaAsset.find({ userId: userIdValue, ownerType, ownerKey, status: 'ready' }).sort({ createdAt: 1, _id: 1 })
  return { images: images.map(publicMedia), journalVersion: ownerType === 'journal' ? journal?.version ?? null : undefined }
}

export async function readMedia(storage: MediaStorage, userId: string, imageId: string, variant: 'full' | 'thumbnail') {
  const media = await MediaAsset.findOne({ _id: imageId, userId: ownerId(userId), status: 'ready' })
  if (!media) throw new MediaNotFoundError('Không tìm thấy ảnh.')
  await ensureCurrentOwner(media)
  const key = variant === 'full' ? media.objectKeyFull : media.objectKeyThumbnail
  let object
  try {
    object = await storage.getObject(key)
  } catch (error: unknown) {
    storageUnavailable(error)
  }
  const stillReady = await MediaAsset.findOne({ _id: media._id, userId: media.userId, status: 'ready' })
  if (!stillReady) throw new MediaNotFoundError('Không tìm thấy ảnh.')
  await ensureCurrentOwner(stillReady)
  return object
}

export async function updateMediaCaption(userId: string, imageId: string, input: UpdateCaptionInput) {
  const userIdValue = ownerId(userId)
  const session = await mongoose.startSession()
  try {
    const result = await session.withTransaction(async () => {
      const media = await MediaAsset.findOne({ _id: imageId, userId: userIdValue, status: 'ready' }).session(session)
      if (!media) throw new MediaNotFoundError('Không tìm thấy ảnh.')
      if (media.version !== input.version) throw new MediaConflictError('Ảnh đã thay đổi ở nơi khác. Hãy tải lại trước khi lưu chú thích.')
      let journalVersion: number | undefined
      if (media.ownerType === 'journal') {
        if (input.journalVersion === undefined) throw new MediaInputError('journalVersion là bắt buộc cho ảnh nhật ký.')
        const journal = await Journal.findOneAndUpdate(
          { userId: userIdValue, date: media.ownerKey, version: input.journalVersion },
          { $inc: { version: 1 } },
          { returnDocument: 'after', session },
        )
        if (!journal) throw new MediaConflictError('Nhật ký đã thay đổi ở nơi khác. Hãy tải lại trước khi sửa chú thích.')
        journalVersion = journal.version
      } else {
        if (input.journalVersion !== undefined) throw new MediaInputError('Không gửi journalVersion cho ảnh công việc.')
        if (!await Task.exists({ _id: media.ownerKey, userId: userIdValue }).session(session)) throw new MediaNotFoundError('Không tìm thấy ảnh.')
      }
      media.caption = input.caption
      media.version += 1
      await media.save({ session })
      return { image: publicMedia(media), journalVersion }
    })
    if (!result) throw new Error('Caption update transaction returned no result')
    return result
  } finally {
    await session.endSession()
  }
}

export async function deleteMedia(storage: MediaStorage, userId: string, imageId: string, input: DeleteMediaInput) {
  const userIdValue = ownerId(userId)
  const session = await mongoose.startSession()
  let ownerType: MediaOwnerType = 'task'
  let ownerKey = ''
  let journalVersion: number | null | undefined
  try {
    const result = await session.withTransaction(async () => {
      const media = await MediaAsset.findOne({ _id: imageId, userId: userIdValue, status: 'ready' }).session(session)
      if (!media) throw new MediaNotFoundError('Không tìm thấy ảnh.')
      if (media.version !== input.version) throw new MediaConflictError('Ảnh đã thay đổi ở nơi khác. Hãy tải lại trước khi xóa.')
      ownerType = media.ownerType
      ownerKey = media.ownerKey
      if (media.ownerType === 'journal') {
        if (input.journalVersion === undefined) throw new MediaInputError('journalVersion là bắt buộc cho ảnh nhật ký.')
        const journal = await Journal.findOne({ userId: userIdValue, date: media.ownerKey, version: input.journalVersion }).session(session)
        if (!journal) throw new MediaConflictError('Nhật ký đã thay đổi ở nơi khác. Hãy tải lại trước khi xóa ảnh.')
        const anotherImage = await MediaAsset.exists({
          _id: { $ne: media._id },
          userId: userIdValue,
          ownerType: 'journal',
          ownerKey: media.ownerKey,
          status: 'ready',
        }).session(session)
        if (!anotherImage && journal.content === '') {
          await Journal.deleteOne({ _id: journal._id, version: input.journalVersion }).session(session)
          journalVersion = null
        } else {
          journal.version += 1
          await journal.save({ session })
          journalVersion = journal.version
        }
      } else {
        if (input.journalVersion !== undefined) throw new MediaInputError('Không gửi journalVersion cho ảnh công việc.')
        if (!await Task.exists({ _id: media.ownerKey, userId: userIdValue }).session(session)) throw new MediaNotFoundError('Không tìm thấy ảnh.')
      }
      media.status = 'deleting'
      media.cleanupReason = 'asset_deleted'
      media.nextCleanupAt = new Date()
      await media.save({ session })
      return true
    })
    if (!result) throw new Error('Media deletion transaction returned no result')
  } finally {
    await session.endSession()
  }
  const queued = await MediaAsset.findById(imageId)
  if (queued && CLEANUP_STATUSES.includes(queued.status as typeof CLEANUP_STATUSES[number])) await cleanupAsset(storage, queued)
  const cleanupPending = Boolean(await MediaAsset.exists({ _id: imageId }))
  return { cleanupPending, journalVersion, ownerKey, ownerType }
}

export async function queueOwnerMediaDeletion(
  session: ClientSession,
  userId: Types.ObjectId,
  ownerType: MediaOwnerType,
  ownerKey: string,
  reason: string,
) {
  const now = new Date()
  const ready = await MediaAsset.updateMany(
    { userId, ownerType, ownerKey, status: 'ready' },
    { $set: { cleanupReason: reason, nextCleanupAt: now, status: 'deleting' } },
    { session },
  )
  const uploading = await MediaAsset.updateMany(
    { userId, ownerType, ownerKey, status: 'uploading' },
    { $set: { cleanupReason: reason, nextCleanupAt: new Date(Date.now() + UPLOAD_DELETE_GRACE_MS), status: 'deleting' } },
    { session },
  )
  return ready.modifiedCount + uploading.modifiedCount
}

export async function cleanupOwnerMedia(storage: MediaStorage | undefined, userId: string, ownerType: MediaOwnerType, ownerKey: string) {
  if (storage) {
    const readyJobs = await MediaAsset.find({ userId: ownerId(userId), ownerType, ownerKey, status: { $in: CLEANUP_STATUSES }, nextCleanupAt: { $lte: new Date() } })
    for (const media of readyJobs) await cleanupAsset(storage, media)
  }
  return Boolean(await MediaAsset.exists({ userId: ownerId(userId), ownerType, ownerKey, status: { $in: CLEANUP_STATUSES } }))
}

export async function taskOwnerKeysWithActiveMedia(session: ClientSession, userId: Types.ObjectId, taskIds: Types.ObjectId[]) {
  if (taskIds.length === 0) return new Set<string>()
  const keys = await MediaAsset.distinct('ownerKey', {
    userId,
    ownerType: 'task',
    ownerKey: { $in: taskIds.map((id) => id.toString()) },
    status: { $in: ACTIVE_STATUSES },
  }).session(session)
  return new Set(keys)
}
