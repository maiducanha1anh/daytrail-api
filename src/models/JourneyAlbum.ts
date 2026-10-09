import mongoose, { type HydratedDocument, type Model, type Types } from 'mongoose'

export type JourneyAlbumRecord = {
  coverImageId: Types.ObjectId | null
  createdAt: Date
  month: number
  title: string
  updatedAt: Date
  userId: Types.ObjectId
  year: number
}

const journeyAlbumSchema = new mongoose.Schema<JourneyAlbumRecord>({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  year: { type: Number, required: true, min: 1, max: 9999 },
  month: { type: Number, required: true, min: 1, max: 12 },
  title: { type: String, default: '', maxlength: 100 },
  coverImageId: { type: mongoose.Schema.Types.ObjectId, default: null, ref: 'MediaAsset' },
}, {
  timestamps: true,
  versionKey: false,
})

journeyAlbumSchema.index(
  { userId: 1, year: 1, month: 1 },
  { name: 'unique_journey_album_month', unique: true },
)

export type JourneyAlbumDocument = HydratedDocument<JourneyAlbumRecord>
export const JourneyAlbum = (mongoose.models.JourneyAlbum as Model<JourneyAlbumRecord> | undefined)
  ?? mongoose.model<JourneyAlbumRecord>('JourneyAlbum', journeyAlbumSchema)
