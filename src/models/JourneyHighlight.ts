import mongoose, { type HydratedDocument, type Model, type Types } from 'mongoose'

export const JOURNEY_HIGHLIGHT_SOURCE_TYPES = ['task', 'journal'] as const
export type JourneyHighlightSourceType = typeof JOURNEY_HIGHLIGHT_SOURCE_TYPES[number]

export type JourneyHighlightRecord = {
  createdAt: Date
  sourceId: Types.ObjectId
  sourceType: JourneyHighlightSourceType
  updatedAt: Date
  userId: Types.ObjectId
}

const journeyHighlightSchema = new mongoose.Schema<JourneyHighlightRecord>({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  sourceType: { type: String, enum: JOURNEY_HIGHLIGHT_SOURCE_TYPES, required: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
}, {
  timestamps: true,
  versionKey: false,
})

journeyHighlightSchema.index(
  { userId: 1, sourceType: 1, sourceId: 1 },
  { name: 'unique_journey_highlight_source', unique: true },
)

export type JourneyHighlightDocument = HydratedDocument<JourneyHighlightRecord>
export const JourneyHighlight = (mongoose.models.JourneyHighlight as Model<JourneyHighlightRecord> | undefined)
  ?? mongoose.model<JourneyHighlightRecord>('JourneyHighlight', journeyHighlightSchema)
