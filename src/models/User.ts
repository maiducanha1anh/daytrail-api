import mongoose, { type HydratedDocument, type Model } from 'mongoose'

export type UserRecord = {
  createdAt: Date
  displayName: string
  email: string
  passwordHash: string
  updatedAt: Date
}

const userSchema = new mongoose.Schema<UserRecord>({
  displayName: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  passwordHash: { type: String, required: true, select: false },
}, {
  timestamps: true,
  versionKey: false,
})

userSchema.index({ email: 1 }, { name: 'unique_user_email', unique: true })

export type UserDocument = HydratedDocument<UserRecord>
export const User = (mongoose.models.User as Model<UserRecord> | undefined) ?? mongoose.model<UserRecord>('User', userSchema)
