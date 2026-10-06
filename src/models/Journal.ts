import mongoose, { type HydratedDocument, type Model, type Types } from 'mongoose'

export type JournalRecord = {
  content: string
  createdAt: Date
  date: string
  updatedAt: Date
  userId: Types.ObjectId
  version: number
}

const journalSchema = new mongoose.Schema<JournalRecord>({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  content: { type: String, default: '', maxlength: 20_000 },
  version: { type: Number, required: true, default: 1, min: 1 },
}, {
  timestamps: true,
  versionKey: false,
})

journalSchema.index({ userId: 1, date: 1 }, { name: 'unique_journal_user_date', unique: true })

export type JournalDocument = HydratedDocument<JournalRecord>
export const Journal = (mongoose.models.Journal as Model<JournalRecord> | undefined) ?? mongoose.model<JournalRecord>('Journal', journalSchema)
