import mongoose, { Types } from 'mongoose'
import { Task } from '../models/Task.js'
import { TaskSeries, type TaskSeriesDocument } from '../models/TaskSeries.js'
import { dateDayNumber, TaskInputError, type CreateTaskSeriesInput } from './validation.js'

const DAY_MS = 86_400_000

export class TaskSeriesNotFoundError extends Error {
  override name = 'TaskSeriesNotFoundError'
}

function ownerId(userId: string) {
  return new Types.ObjectId(userId)
}

function dateFromDayNumber(dayNumber: number) {
  const date = new Date(dayNumber * DAY_MS)
  const year = String(date.getUTCFullYear()).padStart(4, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isoWeekday(dayNumber: number) {
  const weekday = new Date(dayNumber * DAY_MS).getUTCDay()
  return weekday === 0 ? 7 : weekday
}

export function recurringDates(input: CreateTaskSeriesInput) {
  const first = dateDayNumber(input.date)
  const last = dateDayNumber(input.endDate)
  const originalDayOfMonth = Number(input.date.slice(8, 10))
  const dates: string[] = []
  for (let dayNumber = first; dayNumber <= last; dayNumber += 1) {
    const date = dateFromDayNumber(dayNumber)
    const matches = input.frequency === 'daily'
      || (input.frequency === 'weekly' && input.weekdays.includes(isoWeekday(dayNumber)))
      || (input.frequency === 'monthly' && Number(date.slice(8, 10)) === originalDayOfMonth)
    if (matches) dates.push(date)
  }
  if (dates.length === 0) throw new TaskInputError('Quy tắc lặp không tạo ra lần thực hiện nào trong khoảng đã chọn.')
  return dates
}

export function publicTaskSeries(series: TaskSeriesDocument) {
  return {
    id: series._id.toString(),
    startDate: series.startDate,
    endDate: series.endDate,
    frequency: series.frequency,
    weekdays: series.weekdays,
    name: series.name,
    startTime: series.startTime,
    endTime: series.endTime,
    priority: series.priority,
    group: series.group,
    description: series.description,
    stoppedFromDate: series.stoppedFromDate,
    createdAt: series.createdAt.toISOString(),
    updatedAt: series.updatedAt.toISOString(),
  }
}

export async function createTaskSeries(userId: string, input: CreateTaskSeriesInput) {
  const dates = recurringDates(input)
  const session = await mongoose.startSession()
  try {
    const result = await session.withTransaction(async () => {
      const [series] = await TaskSeries.create([{
        userId: ownerId(userId),
        startDate: input.date,
        endDate: input.endDate,
        frequency: input.frequency,
        weekdays: input.weekdays,
        name: input.name,
        startTime: input.startTime,
        endTime: input.endTime,
        priority: input.priority,
        group: input.group,
        description: input.description,
      }], { session })
      if (!series) throw new Error('Task series was not created')
      await Task.insertMany(dates.map((date) => ({
        userId: ownerId(userId),
        date,
        originalDate: date,
        seriesId: series._id,
        name: input.name,
        startTime: input.startTime,
        endTime: input.endTime,
        priority: input.priority,
        group: input.group,
        description: input.description,
        note: null,
        repeat: input.frequency,
        completed: false,
        completedAt: null,
      })), { ordered: true, session })
      return { series, createdCount: dates.length }
    })
    if (!result) throw new Error('Task series transaction did not return a result')
    return { series: publicTaskSeries(result.series), createdCount: result.createdCount }
  } finally {
    await session.endSession()
  }
}

export async function getTaskSeries(userId: string, seriesId: string) {
  const series = await TaskSeries.findOne({ _id: seriesId, userId: ownerId(userId) })
  if (!series) throw new TaskSeriesNotFoundError('Không tìm thấy chuỗi lặp.')
  return publicTaskSeries(series)
}

export async function stopTaskSeries(userId: string, seriesId: string, requestedFromDate: string) {
  const owner = ownerId(userId)
  const session = await mongoose.startSession()
  try {
    const result = await session.withTransaction(async () => {
      const series = await TaskSeries.findOne({ _id: seriesId, userId: owner }).session(session)
      if (!series) throw new TaskSeriesNotFoundError('Không tìm thấy chuỗi lặp.')
      if (requestedFromDate < series.startDate || requestedFromDate > series.endDate) {
        throw new TaskInputError('fromDate phải nằm trong khoảng ngày của chuỗi lặp.')
      }
      const fromDate = series.stoppedFromDate && series.stoppedFromDate < requestedFromDate
        ? series.stoppedFromDate
        : requestedFromDate
      const occurrences = await Task.find({
        userId: owner,
        seriesId: series._id,
        originalDate: { $gte: fromDate },
      }).session(session)
      const removableIds = occurrences
        .filter((task) => !task.completed && task.note === null)
        .map((task) => task._id)
      if (removableIds.length > 0) {
        await Task.deleteMany({ _id: { $in: removableIds }, userId: owner, seriesId: series._id }).session(session)
      }
      series.stoppedFromDate = fromDate
      await series.save({ session })
      return {
        series,
        removedCount: removableIds.length,
        keptCount: occurrences.length - removableIds.length,
      }
    })
    if (!result) throw new Error('Stop task series transaction did not return a result')
    return {
      series: publicTaskSeries(result.series),
      removedCount: result.removedCount,
      keptCount: result.keptCount,
    }
  } finally {
    await session.endSession()
  }
}
