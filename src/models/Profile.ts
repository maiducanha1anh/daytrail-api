import mongoose, { type HydratedDocument, type Model, type Types } from 'mongoose'

export type ProfileRecord = {
  about: string
  aspiration: string
  avatarImageId: Types.ObjectId | null
  createdAt: Date
  decorationImageIds: Types.ObjectId[]
  tagline: string
  updatedAt: Date
  userId: Types.ObjectId
  version: number
}

const profileSchema = new mongoose.Schema<ProfileRecord>({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  tagline: { type: String, default: '', maxlength: 160 },
  about: { type: String, default: '', maxlength: 3_000 },
  aspiration: { type: String, default: '', maxlength: 2_000 },
  avatarImageId: { type: mongoose.Schema.Types.ObjectId, default: null, ref: 'ProfileImage' },
  decorationImageIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ProfileImage' }],
  version: { type: Number, default: 1, required: true, min: 1 },
}, {
  timestamps: true,
  versionKey: false,
})

profileSchema.index({ userId: 1 }, { name: 'unique_profile_user', unique: true })

export type ProfileDocument = HydratedDocument<ProfileRecord>
export const Profile = (mongoose.models.Profile as Model<ProfileRecord> | undefined)
  ?? mongoose.model<ProfileRecord>('Profile', profileSchema)
