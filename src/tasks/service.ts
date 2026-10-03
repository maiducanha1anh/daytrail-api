import { Types } from 'mongoose'
import { Task, type TaskDocument } from '../models/Task.js'
import { TaskInputError, type CreateTaskInput, type TaskListInput, type UpdateTaskInput, validateTimeOrder } from './validation.js'

export class TaskNotFoundError extends Error {
  override name = 'TaskNotFoundError'
}

function ownerId(userId: string) {
  return new Types.ObjectId(userId)
}

export function publicTask(task: TaskDocument) {
  return {
    id: task._id.toString(),
    date: task.date,
    name: task.name,
    startTime: task.startTime,
    endTime: task.endTime,
    priority: task.priority,
    group: task.group,
    description: task.description,
    note: task.note,
    repeat: task.repeat,
    completed: task.completed,
    completedAt: task.completedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  }
}

export async function createTask(userId: string, input: CreateTaskInput) {
  const task = await Task.create({ ...input, userId: ownerId(userId) })
  return publicTask(task)
}

export async function listTasks(userId: string, input: TaskListInput) {
  const filter = { userId: ownerId(userId), date: { $gte: input.from, $lte: input.to } }
  const [tasks, total] = await Promise.all([
    Task.find(filter).sort({ startTime: 1, _id: 1 }).skip((input.page - 1) * input.limit).limit(input.limit),
    Task.countDocuments(filter),
  ])
  return {
    tasks: tasks.map(publicTask),
    pagination: {
      page: input.page,
      limit: input.limit,
      total,
      pages: total === 0 ? 0 : Math.ceil(total / input.limit),
    },
  }
}

async function ownedTask(userId: string, taskId: string) {
  const task = await Task.findOne({ _id: taskId, userId: ownerId(userId) })
  if (!task) throw new TaskNotFoundError('Không tìm thấy công việc.')
  return task
}

export async function getTask(userId: string, taskId: string) {
  return publicTask(await ownedTask(userId, taskId))
}

export async function updateTask(userId: string, taskId: string, changes: UpdateTaskInput) {
  const task = await ownedTask(userId, taskId)
  const startTime = changes.startTime ?? task.startTime
  const endTime = changes.endTime ?? task.endTime
  validateTimeOrder(startTime, endTime)
  Object.assign(task, changes)
  await task.save()
  return publicTask(task)
}

export async function moveTask(userId: string, taskId: string, date: string) {
  const task = await ownedTask(userId, taskId)
  task.date = date
  await task.save()
  return publicTask(task)
}

export async function setTaskCompletion(userId: string, taskId: string, completed: boolean) {
  const changedTask = await Task.findOneAndUpdate(
    { _id: taskId, userId: ownerId(userId), completed: !completed },
    { $set: { completed, completedAt: completed ? new Date() : null } },
    { returnDocument: 'after' },
  )
  if (changedTask) return publicTask(changedTask)
  const currentTask = await Task.findOne({ _id: taskId, userId: ownerId(userId) })
  if (!currentTask) throw new TaskNotFoundError('Không tìm thấy công việc.')
  return publicTask(currentTask)
}

export async function deleteTask(userId: string, taskId: string) {
  const result = await Task.deleteOne({ _id: taskId, userId: ownerId(userId) })
  if (result.deletedCount !== 1) throw new TaskNotFoundError('Không tìm thấy công việc.')
}

export async function taskSummary(userId: string, date: string) {
  const [summary] = await Task.aggregate<{ completed: number; total: number }>([
    { $match: { userId: ownerId(userId), date } },
    { $group: { _id: null, total: { $sum: 1 }, completed: { $sum: { $cond: ['$completed', 1, 0] } } } },
  ])
  const total = summary?.total ?? 0
  const completed = summary?.completed ?? 0
  return {
    date,
    total,
    completed,
    incomplete: total - completed,
    completionPercentage: total === 0 ? 0 : Math.round((completed / total) * 100),
  }
}

export function validateTaskId(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{24}$/.test(value)) throw new TaskInputError('ID công việc không hợp lệ.')
  return value
}
