import mongoose, { type Model, type Types } from 'mongoose'

export type AccountTokenPurpose = 'email_verification' | 'password_reset'

export type AccountTokenRecord = {
  createdAt: Date
  deliveredAt?: Date
  email: string
  expiresAt: Date
  purpose: AccountTokenPurpose
  tokenHash: string
  updatedAt: Date
  userId: Types.ObjectId
}

const accountTokenSchema = new mongoose.Schema<AccountTokenRecord>({
  tokenHash: { type: String, required: true },
  purpose: { type: String, enum: ['email_verification', 'password_reset'], required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  email: { type: String, required: true, maxlength: 254 },
  expiresAt: { type: Date, required: true },
  deliveredAt: { type: Date },
}, {
  timestamps: true,
  versionKey: false,
})

accountTokenSchema.index({ tokenHash: 1 }, { name: 'unique_account_token_hash', unique: true })
accountTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'expired_account_tokens_ttl' })
accountTokenSchema.index({ userId: 1, purpose: 1, deliveredAt: 1 }, { name: 'account_tokens_by_user_purpose' })

export const AccountToken = (mongoose.models.AccountToken as Model<AccountTokenRecord> | undefined)
  ?? mongoose.model<AccountTokenRecord>('AccountToken', accountTokenSchema)
