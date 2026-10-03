import mongoose, { type Model, type Types } from 'mongoose'

export type SessionRecord = {
  createdAt: Date
  expiresAt: Date
  tokenHash: string
  updatedAt: Date
  userId: Types.ObjectId
}

const sessionSchema = new mongoose.Schema<SessionRecord>({
  tokenHash: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  expiresAt: { type: Date, required: true },
}, {
  timestamps: true,
  versionKey: false,
})

sessionSchema.index({ tokenHash: 1 }, { name: 'unique_session_token_hash', unique: true })
sessionSchema.index({ userId: 1 }, { name: 'sessions_by_user' })
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'expired_sessions_ttl' })

export const Session = (mongoose.models.Session as Model<SessionRecord> | undefined) ?? mongoose.model<SessionRecord>('Session', sessionSchema)
