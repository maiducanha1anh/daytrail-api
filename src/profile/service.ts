import mongoose, { Types, type ClientSession } from 'mongoose'
import { mediaPayloadHash, processImage, type ProcessedImage } from '../media/image.js'
import { MediaStorageOperationError, type MediaStorage } from '../media/storage.js'
import { Profile } from '../models/Profile.js'
import {
  ProfileImage,
  type ProfileImageDocument,
  type ProfileImageRole,
} from '../models/ProfileImage.js'
import { User } from '../models/User.js'
import { MediaConflictError, MediaStorageUnavailableError } from '../media/errors.js'
import { ProfileConflictError, ProfileNotFoundError } from './errors.js'
import type { UpdateProfileInput } from './validation.js'

const ACTIVE_STATUSES = ['uploading', 'ready'] as const
const CLEANUP_STATUSES = ['deleting', 'cleanup_failed'] as const
const PROFILE_IMAGE_SLOTS = 10
const TEMPORARY_IMAGE_TTL_MS = 60 * 60 * 1_000
const STALE_UPLOAD_MS = 15 * 60 * 1_000

type UploadProfileImageInput = {
  caption: string
  clientUploadId: string
  file: Buffer
  keyPrefix: string
  role: ProfileImageRole
  userId: string
}

function ownerId(userId: string) {
  return new Types.ObjectId(userId)
}

function isDuplicateKeyError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000)
}

function cleanupCode(error: unknown) {
  if (error instanceof MediaStorageOperationError) return error.safeCode
  return error instanceof Error ? error.name : 'UnknownError'
}

function storageUnavailable(error: unknown): never {
  if (error instanceof MediaStorageOperationError) throw new MediaStorageUnavailableError(`Kho ảnh tạm thời không sẵn sàng (${error.safeCode}).`)
  throw error
}

export function publicProfileImage(image: ProfileImageDocument) {
  return {
    id: image._id.toString(),
    byteSize: image.byteSize,
    caption: image.caption,
    createdAt: image.createdAt.toISOString(),
    fullHeight: image.fullHeight,
    fullUrl: `/api/profile/images/${image._id.toString()}/file?variant=full`,
    fullWidth: image.fullWidth,
    mimeType: image.mimeType,
    role: image.role,
    thumbnailHeight: image.thumbnailHeight,
    thumbnailUrl: `/api/profile/images/${image._id.toString()}/file?variant=thumbnail`,
    thumbnailWidth: image.thumbnailWidth,
    updatedAt: image.updatedAt.toISOString(),
    version: image.version,
  }
}

async function profileResponse(userId: Types.ObjectId) {
  const [user, profile] = await Promise.all([
    User.findById(userId),
    Profile.findOne({ userId }),
  ])
  if (!user) throw new ProfileNotFoundError('Không tìm thấy tài khoản.')
  const imageIds = profile
    ? [
        ...(profile.avatarImageId ? [profile.avatarImageId] : []),
        ...profile.decorationImageIds,
      ]
    : []
  const images = imageIds.length > 0
    ? await ProfileImage.find({ _id: { $in: imageIds }, userId, status: 'ready', attached: true })
    : []
  const byId = new Map(images.map((image) => [image._id.toString(), image]))
  const avatar = profile?.avatarImageId ? byId.get(profile.avatarImageId.toString()) : undefined
  const decorations = profile?.decorationImageIds
    .map((id) => byId.get(id.toString()))
    .filter((image): image is ProfileImageDocument => Boolean(image)) ?? []
  return {
    profile: {
      about: profile?.about ?? '',
      aspiration: profile?.aspiration ?? '',
      avatar: avatar ? publicProfileImage(avatar) : null,
      createdAt: (profile?.createdAt ?? user.createdAt).toISOString(),
      decorations: decorations.map(publicProfileImage),
      displayName: user.displayName,
      tagline: profile?.tagline ?? '',
      updatedAt: (profile?.updatedAt ?? user.updatedAt).toISOString(),
      version: profile?.version ?? 0,
    },
  }
}

export function getProfile(userId: string) {
  return profileResponse(ownerId(userId))
}

async function reserveProfileImage(input: UploadProfileImageInput, processed: ProcessedImage, payloadHash: string) {
  const userId = ownerId(input.userId)
  for (let attempt = 0; attempt <= PROFILE_IMAGE_SLOTS; attempt += 1) {
    const session = await mongoose.startSession()
    try {
      const result = await session.withTransaction(async () => {
        if (!await User.exists({ _id: userId }).session(session)) throw new ProfileNotFoundError('Không tìm thấy tài khoản.')
        const existing = await ProfileImage.findOne({ userId, clientUploadId: input.clientUploadId }).session(session)
        if (existing) {
          if (existing.payloadHash !== payloadHash) throw new MediaConflictError('clientUploadId đã được dùng với ảnh hồ sơ khác.')
          if (existing.status === 'ready') return { image: existing, reserved: false }
          throw new MediaConflictError('Ảnh với clientUploadId này đang xử lý hoặc đang được dọn.')
        }
        const used = await ProfileImage.find({ userId }).select('quotaSlot').session(session)
        const occupied = new Set(used.map((image) => image.quotaSlot))
        const quotaSlot = Array.from({ length: PROFILE_IMAGE_SLOTS }, (_value, index) => index)
          .find((slot) => !occupied.has(slot))
        if (quotaSlot === undefined) throw new MediaConflictError('Bạn đang có quá nhiều ảnh hồ sơ hoặc ảnh tạm. Hãy lưu/hủy thay đổi rồi thử lại.')
        const imageId = new Types.ObjectId()
        const objectBase = `${input.keyPrefix}/profiles/${imageId.toString()}`
        const [image] = await ProfileImage.create([{
          _id: imageId,
          attached: false,
          byteSize: processed.full.length,
          caption: input.caption,
          clientUploadId: input.clientUploadId,
          expiresAt: new Date(Date.now() + TEMPORARY_IMAGE_TTL_MS),
          fullHeight: processed.fullHeight,
          fullWidth: processed.fullWidth,
          mimeType: 'image/webp',
          objectKeyFull: `${objectBase}/full.webp`,
          objectKeyThumbnail: `${objectBase}/thumbnail.webp`,
          payloadHash,
          quotaSlot,
          role: input.role,
          status: 'uploading',
          thumbnailByteSize: processed.thumbnail.length,
          thumbnailHeight: processed.thumbnailHeight,
          thumbnailWidth: processed.thumbnailWidth,
          userId,
        }], { session })
        if (!image) throw new Error('Profile image reservation was not created')
        return { image, reserved: true }
      })
      if (!result) throw new Error('Profile image reservation transaction returned no result')
      return result
    } catch (error: unknown) {
      if (isDuplicateKeyError(error) && attempt < PROFILE_IMAGE_SLOTS) continue
      throw error
    } finally {
      await session.endSession()
    }
  }
  throw new MediaConflictError('Không thể giữ chỗ upload ảnh hồ sơ. Hãy thử lại.')
}

async function queueProfileImageCleanup(imageId: Types.ObjectId, reason: string) {
  await ProfileImage.updateOne(
    { _id: imageId, status: { $in: [...ACTIVE_STATUSES, ...CLEANUP_STATUSES] } },
    { $set: { cleanupReason: reason, nextCleanupAt: new Date(), status: 'deleting' } },
  )
}

async function cleanupProfileImage(storage: MediaStorage, image: ProfileImageDocument) {
  const results = await Promise.allSettled([
    storage.deleteObject(image.objectKeyFull),
    storage.deleteObject(image.objectKeyThumbnail),
  ])
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (!failure) {
    await ProfileImage.deleteOne({ _id: image._id, status: { $in: CLEANUP_STATUSES } })
    return true
  }
  const attempts = image.cleanupAttempts + 1
  const delayMs = Math.min(60 * 60 * 1_000, 5_000 * (2 ** Math.min(attempts - 1, 7)))
  await ProfileImage.updateOne(
    { _id: image._id, status: { $in: CLEANUP_STATUSES } },
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

export async function uploadProfileImage(storage: MediaStorage, input: UploadProfileImageInput) {
  const processed = await processImage(input.file)
  const payloadHash = mediaPayloadHash(input.file, `${input.role}\0${input.caption}`)
  const reservation = await reserveProfileImage(input, processed, payloadHash)
  if (!reservation.reserved) return { created: false, image: publicProfileImage(reservation.image) }
  const image = reservation.image
  try {
    await storage.putObject(image.objectKeyFull, processed.full, 'image/webp')
    await storage.putObject(image.objectKeyThumbnail, processed.thumbnail, 'image/webp')
  } catch (error: unknown) {
    await queueProfileImageCleanup(image._id, 'profile_upload_storage_failed').catch(() => undefined)
    const queued = await ProfileImage.findById(image._id)
    if (queued?.status === 'deleting') await cleanupProfileImage(storage, queued).catch(() => false)
    storageUnavailable(error)
  }
  const activated = await ProfileImage.findOneAndUpdate(
    { _id: image._id, userId: ownerId(input.userId), status: 'uploading' },
    { $set: { status: 'ready' } },
    { returnDocument: 'after' },
  )
  if (!activated) {
    await queueProfileImageCleanup(image._id, 'profile_upload_activation_failed').catch(() => undefined)
    throw new MediaConflictError('Ảnh hồ sơ không còn hợp lệ. Hãy thử lại.')
  }
  return { created: true, image: publicProfileImage(activated) }
}

export async function readProfileImage(storage: MediaStorage, userId: string, imageId: string, variant: 'full' | 'thumbnail') {
  const image = await ProfileImage.findOne({ _id: imageId, userId: ownerId(userId), status: 'ready' })
  if (!image) throw new ProfileNotFoundError('Không tìm thấy ảnh hồ sơ.')
  try {
    return await storage.getObject(variant === 'full' ? image.objectKeyFull : image.objectKeyThumbnail)
  } catch (error: unknown) {
    storageUnavailable(error)
  }
}

async function validateSelectedImages(session: ClientSession, userId: Types.ObjectId, input: UpdateProfileInput) {
  const ids = [...(input.avatarImageId ? [input.avatarImageId] : []), ...input.decorationImageIds]
  if (ids.length === 0) return []
  const images = await ProfileImage.find({ _id: { $in: ids }, userId, status: 'ready' }).session(session)
  if (images.length !== ids.length) throw new ProfileNotFoundError('Một ảnh hồ sơ không tồn tại hoặc không thuộc tài khoản này.')
  const byId = new Map(images.map((image) => [image._id.toString(), image]))
  if (input.avatarImageId && byId.get(input.avatarImageId)?.role !== 'avatar') throw new ProfileNotFoundError('Ảnh avatar không hợp lệ.')
  if (input.decorationImageIds.some((id) => byId.get(id)?.role !== 'decoration')) throw new ProfileNotFoundError('Ảnh trang trí không hợp lệ.')
  return images
}

export async function updateProfile(storage: MediaStorage | undefined, userId: string, input: UpdateProfileInput) {
  const userIdValue = ownerId(userId)
  const session = await mongoose.startSession()
  let cleanupIds: Types.ObjectId[] = []
  try {
    await session.withTransaction(async () => {
      // MongoDB transactions do not support parallel operations on one session.
      const user = await User.findById(userIdValue).session(session)
      const current = await Profile.findOne({ userId: userIdValue }).session(session)
      if (!user) throw new ProfileNotFoundError('Không tìm thấy tài khoản.')
      const currentVersion = current?.version ?? 0
      if (currentVersion !== input.version) throw new ProfileConflictError('Hồ sơ đã thay đổi ở nơi khác. Hãy tải bản mới nhất trước khi lưu.')
      const images = await validateSelectedImages(session, userIdValue, input)
      const selectedIds = new Set(images.map((image) => image._id.toString()))
      const previousIds = current
        ? [...(current.avatarImageId ? [current.avatarImageId] : []), ...current.decorationImageIds]
        : []
      cleanupIds = previousIds.filter((id) => !selectedIds.has(id.toString()))
      const nextValues = {
        about: input.about,
        aspiration: input.aspiration,
        avatarImageId: input.avatarImageId ? new Types.ObjectId(input.avatarImageId) : null,
        decorationImageIds: input.decorationImageIds.map((id) => new Types.ObjectId(id)),
        tagline: input.tagline,
        version: currentVersion + 1,
      }
      if (current) {
        current.set(nextValues)
        await current.save({ session })
      } else {
        try {
          await Profile.create([{ ...nextValues, userId: userIdValue }], { session })
        } catch (error: unknown) {
          if (isDuplicateKeyError(error)) throw new ProfileConflictError('Hồ sơ đã được tạo ở nơi khác. Hãy tải lại trước khi lưu.')
          throw error
        }
      }
      user.displayName = input.displayName
      await user.save({ session })
      for (const image of images) {
        const caption = Object.hasOwn(input.captions, image._id.toString()) ? input.captions[image._id.toString()] : image.caption
        await ProfileImage.updateOne(
          { _id: image._id, userId: userIdValue, status: 'ready' },
          { $set: { attached: true, caption, expiresAt: null }, $inc: { version: 1 } },
          { session },
        )
      }
      if (cleanupIds.length > 0) {
        await ProfileImage.updateMany(
          { _id: { $in: cleanupIds }, userId: userIdValue, status: { $in: ACTIVE_STATUSES } },
          { $set: { attached: false, cleanupReason: 'profile_replaced', nextCleanupAt: new Date(), status: 'deleting' } },
          { session },
        )
      }
    })
  } finally {
    await session.endSession()
  }
  if (storage && cleanupIds.length > 0) {
    const queued = await ProfileImage.find({ _id: { $in: cleanupIds }, status: { $in: CLEANUP_STATUSES } })
    await Promise.allSettled(queued.map((image) => cleanupProfileImage(storage, image)))
  }
  return profileResponse(userIdValue)
}

export async function discardProfileImages(storage: MediaStorage, userId: string, imageIds: string[]) {
  const userIdValue = ownerId(userId)
  const ids = imageIds.map((id) => new Types.ObjectId(id))
  const images = await ProfileImage.find({ _id: { $in: ids }, userId: userIdValue, attached: false, status: { $in: ACTIVE_STATUSES } })
  if (images.length !== ids.length) throw new ProfileNotFoundError('Một ảnh tạm không tồn tại hoặc đã được gắn vào hồ sơ.')
  await ProfileImage.updateMany(
    { _id: { $in: ids }, userId: userIdValue, attached: false, status: { $in: ACTIVE_STATUSES } },
    { $set: { cleanupReason: 'profile_draft_discarded', nextCleanupAt: new Date(), status: 'deleting' } },
  )
  const queued = await ProfileImage.find({ _id: { $in: ids }, status: { $in: CLEANUP_STATUSES } })
  const results = await Promise.all(queued.map((image) => cleanupProfileImage(storage, image)))
  return { cleanupPending: results.some((cleaned) => !cleaned) }
}

export async function processProfileCleanupJobs(storage: MediaStorage, limit = 20) {
  const now = new Date()
  await ProfileImage.updateMany(
    {
      attached: false,
      status: 'ready',
      expiresAt: { $lte: now },
    },
    { $set: { cleanupReason: 'profile_draft_expired', nextCleanupAt: now, status: 'deleting' } },
  )
  await ProfileImage.updateMany(
    { status: 'uploading', createdAt: { $lt: new Date(Date.now() - STALE_UPLOAD_MS) } },
    { $set: { cleanupReason: 'profile_upload_stale', nextCleanupAt: now, status: 'deleting' } },
  )
  const jobs = await ProfileImage.find({
    status: { $in: CLEANUP_STATUSES },
    $or: [{ nextCleanupAt: null }, { nextCleanupAt: { $lte: now } }],
  }).sort({ nextCleanupAt: 1, createdAt: 1 }).limit(limit)
  let cleaned = 0
  let failed = 0
  for (const image of jobs) {
    if (await cleanupProfileImage(storage, image)) cleaned += 1
    else failed += 1
  }
  return { cleaned, failed }
}

export function startProfileCleanupWorker(storage: MediaStorage, intervalMs = 30_000) {
  let running = false
  const run = async () => {
    if (running) return
    running = true
    try {
      const result = await processProfileCleanupJobs(storage)
      if (result.failed > 0) console.error(`Profile image cleanup retry pending (${result.failed})`)
    } catch (error: unknown) {
      console.error(`Profile image cleanup failed (${cleanupCode(error)})`)
    } finally {
      running = false
    }
  }
  void run()
  const timer = setInterval(() => void run(), intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
