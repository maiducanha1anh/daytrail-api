import mongoose, { type HydratedDocument, type Model, type Types } from 'mongoose'

export const TASK_PRIORITIES = ['low', 'normal', 'high'] as const
export type TaskPriority = typeof TASK_PRIORITIES[number]
export const TASK_REPEAT_VALUES = ['none', 'daily', 'weekly', 'monthly'] as const
export const TASK_SERIES_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const
export type TaskRepeat = typeof TASK_REPEAT_VALUES[number]
export type TaskSeriesFrequency = typeof TASK_SERIES_FREQUENCIES[number]

export type TaskRecord = {
  completed: boolean
  completedAt: Date | null
  createdAt: Date
  date: string
  description: string | null
  endTime: string
  group: string | null
  name: string
  note: string | null
  originalDate: string | null
  priority: TaskPriority
  repeat: TaskRepeat
  seriesId: Types.ObjectId | null
  startTime: string
  updatedAt: Date
  userId: Types.ObjectId
}

const taskSchema = new mongoose.Schema<TaskRecord>({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  date: { type: String, required: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  startTime: { type: String, required: true },
  endTime: { type: String, required: true },
  priority: { type: String, enum: TASK_PRIORITIES, default: 'normal', required: true },
  group: { type: String, default: null, maxlength: 80 },
  description: { type: String, default: null, maxlength: 2_000 },
  note: { type: String, default: null, maxlength: 5_000 },
  repeat: { type: String, enum: TASK_REPEAT_VALUES, default: 'none', required: true },
  seriesId: { type: mongoose.Schema.Types.ObjectId, default: null, ref: 'TaskSeries' },
  originalDate: { type: String, default: null },
  completed: { type: Boolean, default: false, required: true },
  completedAt: { type: Date, default: null },
}, {
  timestamps: true,
  versionKey: false,
})

taskSchema.index({ userId: 1, date: 1, startTime: 1, _id: 1 }, { name: 'tasks_by_user_date_time' })
taskSchema.index(
  { userId: 1, seriesId: 1, originalDate: 1 },
  {
    name: 'unique_task_series_original_date',
    partialFilterExpression: { seriesId: { $type: 'objectId' }, originalDate: { $type: 'string' } },
    unique: true,
  },
)

export type TaskDocument = HydratedDocument<TaskRecord>
export const Task = (mongoose.models.Task as Model<TaskRecord> | undefined) ?? mongoose.model<TaskRecord>('Task', taskSchema)
