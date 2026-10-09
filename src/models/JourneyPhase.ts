import mongoose, { type HydratedDocument, type Model, type Types } from 'mongoose'

export type JourneyPhaseRecord = {
  coverImageId: Types.ObjectId | null
  createdAt: Date
  endDate: string
  introduction: string
  name: string
  startDate: string
  summary: string
  updatedAt: Date
  userId: Types.ObjectId
}

const journeyPhaseSchema = new mongoose.Schema<JourneyPhaseRecord>({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  startDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  endDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  coverImageId: { type: mongoose.Schema.Types.ObjectId, default: null, ref: 'MediaAsset' },
  introduction: { type: String, default: '', maxlength: 2_000 },
  summary: { type: String, default: '', maxlength: 5_000 },
}, {
  timestamps: true,
  versionKey: false,
})

journeyPhaseSchema.index(
  { userId: 1, startDate: -1, endDate: -1, _id: -1 },
  { name: 'journey_phases_by_user_dates' },
)

export type JourneyPhaseDocument = HydratedDocument<JourneyPhaseRecord>
export const JourneyPhase = (mongoose.models.JourneyPhase as Model<JourneyPhaseRecord> | undefined)
  ?? mongoose.model<JourneyPhaseRecord>('JourneyPhase', journeyPhaseSchema)
