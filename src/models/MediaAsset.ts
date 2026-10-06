import mongoose, { type HydratedDocument, type Model, type Types } from 'mongoose'

export const MEDIA_OWNER_TYPES = ['task', 'journal'] as const
export const MEDIA_STATUSES = ['uploading', 'ready', 'deleting', 'cleanup_failed'] as const
export type MediaOwnerType = typeof MEDIA_OWNER_TYPES[number]
export type MediaStatus = typeof MEDIA_STATUSES[number]

export type MediaAssetRecord = {
  byteSize: number
  caption: string
  cleanupAttempts: number
  cleanupReason: string | null
  clientUploadId: string
  createdAt: Date
  fullHeight: number
  fullWidth: number
  lastCleanupCode: string | null
  mimeType: 'image/webp'
  nextCleanupAt: Date | null
  objectKeyFull: string
  objectKeyThumbnail: string
  ownerKey: string
  ownerType: MediaOwnerType
  payloadHash: string
  quotaSlot: number
  status: MediaStatus
  thumbnailByteSize: number
  thumbnailHeight: number
  thumbnailWidth: number
  updatedAt: Date
  userId: Types.ObjectId
  version: number
}

const mediaAssetSchema = new mongoose.Schema<MediaAssetRecord>({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  ownerType: { type: String, enum: MEDIA_OWNER_TYPES, required: true },
  ownerKey: { type: String, required: true },
  quotaSlot: { type: Number, required: true, min: 0, max: 11 },
  clientUploadId: { type: String, required: true },
  payloadHash: { type: String, required: true },
  objectKeyFull: { type: String, required: true },
  objectKeyThumbnail: { type: String, required: true },
  mimeType: { type: String, enum: ['image/webp'], required: true },
  byteSize: { type: Number, required: true, min: 1 },
  thumbnailByteSize: { type: Number, required: true, min: 1 },
  fullWidth: { type: Number, required: true, min: 1 },
  fullHeight: { type: Number, required: true, min: 1 },
  thumbnailWidth: { type: Number, required: true, min: 1 },
  thumbnailHeight: { type: Number, required: true, min: 1 },
  caption: { type: String, default: '', maxlength: 500 },
  version: { type: Number, default: 1, required: true, min: 1 },
  status: { type: String, enum: MEDIA_STATUSES, default: 'uploading', required: true },
  cleanupReason: { type: String, default: null },
  cleanupAttempts: { type: Number, default: 0, required: true, min: 0 },
  nextCleanupAt: { type: Date, default: null },
  lastCleanupCode: { type: String, default: null },
}, {
  timestamps: true,
  versionKey: false,
})

mediaAssetSchema.index(
  { userId: 1, ownerType: 1, ownerKey: 1, quotaSlot: 1 },
  { name: 'unique_media_owner_slot', unique: true },
)
mediaAssetSchema.index(
  { userId: 1, ownerType: 1, ownerKey: 1, clientUploadId: 1 },
  { name: 'unique_media_upload_id', unique: true },
)
mediaAssetSchema.index(
  { status: 1, nextCleanupAt: 1, createdAt: 1 },
  { name: 'media_cleanup_queue' },
)
mediaAssetSchema.index(
  { userId: 1, ownerType: 1, ownerKey: 1, status: 1, createdAt: 1 },
  { name: 'media_by_owner' },
)

export type MediaAssetDocument = HydratedDocument<MediaAssetRecord>
export const MediaAsset = (mongoose.models.MediaAsset as Model<MediaAssetRecord> | undefined)
  ?? mongoose.model<MediaAssetRecord>('MediaAsset', mediaAssetSchema)
