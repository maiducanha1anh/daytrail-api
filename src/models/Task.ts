import mongoose, { type HydratedDocument, type Model, type Types } from 'mongoose'

export const TASK_PRIORITIES = ['low', 'normal', 'high'] as const
export type TaskPriority = typeof TASK_PRIORITIES[number]

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
  priority: TaskPriority
  repeat: 'none'
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
  repeat: { type: String, enum: ['none'], default: 'none', required: true },
  completed: { type: Boolean, default: false, required: true },
  completedAt: { type: Date, default: null },
}, {
  timestamps: true,
  versionKey: false,
})

taskSchema.index({ userId: 1, date: 1, startTime: 1, _id: 1 }, { name: 'tasks_by_user_date_time' })

export type TaskDocument = HydratedDocument<TaskRecord>
export const Task = (mongoose.models.Task as Model<TaskRecord> | undefined) ?? mongoose.model<TaskRecord>('Task', taskSchema)
