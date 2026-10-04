import mongoose, { type HydratedDocument, type Model, type Types } from 'mongoose'
import { TASK_PRIORITIES, TASK_SERIES_FREQUENCIES, type TaskPriority, type TaskSeriesFrequency } from './Task.js'

export type TaskSeriesRecord = {
  createdAt: Date
  description: string | null
  endDate: string
  endTime: string
  frequency: TaskSeriesFrequency
  group: string | null
  name: string
  priority: TaskPriority
  startDate: string
  startTime: string
  stoppedFromDate: string | null
  updatedAt: Date
  userId: Types.ObjectId
  weekdays: number[]
}

const taskSeriesSchema = new mongoose.Schema<TaskSeriesRecord>({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  startDate: { type: String, required: true },
  endDate: { type: String, required: true },
  frequency: { type: String, enum: TASK_SERIES_FREQUENCIES, required: true },
  weekdays: [{ type: Number, min: 1, max: 7 }],
  name: { type: String, required: true, trim: true, maxlength: 120 },
  startTime: { type: String, required: true },
  endTime: { type: String, required: true },
  priority: { type: String, enum: TASK_PRIORITIES, default: 'normal', required: true },
  group: { type: String, default: null, maxlength: 80 },
  description: { type: String, default: null, maxlength: 2_000 },
  stoppedFromDate: { type: String, default: null },
}, {
  timestamps: true,
  versionKey: false,
})

taskSeriesSchema.index({ userId: 1, endDate: 1 }, { name: 'task_series_by_user_end_date' })

export type TaskSeriesDocument = HydratedDocument<TaskSeriesRecord>
export const TaskSeries = (mongoose.models.TaskSeries as Model<TaskSeriesRecord> | undefined) ?? mongoose.model<TaskSeriesRecord>('TaskSeries', taskSeriesSchema)
