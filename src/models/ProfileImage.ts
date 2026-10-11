import mongoose, { type HydratedDocument, type Model, type Types } from 'mongoose'

export const PROFILE_IMAGE_ROLES = ['avatar', 'decoration'] as const
export const PROFILE_IMAGE_STATUSES = ['uploading', 'ready', 'deleting', 'cleanup_failed'] as const
export type ProfileImageRole = typeof PROFILE_IMAGE_ROLES[number]
export type ProfileImageStatus = typeof PROFILE_IMAGE_STATUSES[number]

export type ProfileImageRecord = {
  attached: boolean
  byteSize: number
  caption: string
  cleanupAttempts: number
  cleanupReason: string | null
  clientUploadId: string
  createdAt: Date
  expiresAt: Date | null
  fullHeight: number
  fullWidth: number
  lastCleanupCode: string | null
  mimeType: 'image/webp'
  nextCleanupAt: Date | null
  objectKeyFull: string
  objectKeyThumbnail: string
  payloadHash: string
  quotaSlot: number
  role: ProfileImageRole
  status: ProfileImageStatus
  thumbnailByteSize: number
  thumbnailHeight: number
  thumbnailWidth: number
  updatedAt: Date
  userId: Types.ObjectId
  version: number
}

const profileImageSchema = new mongoose.Schema<ProfileImageRecord>({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  role: { type: String, enum: PROFILE_IMAGE_ROLES, required: true },
  attached: { type: Boolean, default: false, required: true },
  quotaSlot: { type: Number, required: true, min: 0, max: 9 },
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
  caption: { type: String, default: '', maxlength: 200 },
  version: { type: Number, default: 1, required: true, min: 1 },
  status: { type: String, enum: PROFILE_IMAGE_STATUSES, default: 'uploading', required: true },
  expiresAt: { type: Date, default: null },
  cleanupReason: { type: String, default: null },
  cleanupAttempts: { type: Number, default: 0, required: true, min: 0 },
  nextCleanupAt: { type: Date, default: null },
  lastCleanupCode: { type: String, default: null },
}, {
  timestamps: true,
  versionKey: false,
})

profileImageSchema.index({ userId: 1, quotaSlot: 1 }, { name: 'unique_profile_image_slot', unique: true })
profileImageSchema.index({ userId: 1, clientUploadId: 1 }, { name: 'unique_profile_upload_id', unique: true })
profileImageSchema.index({ status: 1, nextCleanupAt: 1, expiresAt: 1 }, { name: 'profile_image_cleanup_queue' })
profileImageSchema.index({ userId: 1, attached: 1, status: 1, createdAt: 1 }, { name: 'profile_images_by_user' })

export type ProfileImageDocument = HydratedDocument<ProfileImageRecord>
export const ProfileImage = (mongoose.models.ProfileImage as Model<ProfileImageRecord> | undefined)
  ?? mongoose.model<ProfileImageRecord>('ProfileImage', profileImageSchema)
