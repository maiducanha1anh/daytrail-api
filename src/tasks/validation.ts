import { TASK_PRIORITIES, type TaskPriority } from '../models/Task.js'

export const TASK_NAME_MAX_LENGTH = 120
export const TASK_GROUP_MAX_LENGTH = 80
export const TASK_DESCRIPTION_MAX_LENGTH = 2_000
export const TASK_NOTE_MAX_LENGTH = 5_000
export const TASK_LIST_DEFAULT_LIMIT = 50
export const TASK_LIST_MAX_LIMIT = 100
export const TASK_RANGE_MAX_DAYS = 366

export class TaskInputError extends Error {
  override name = 'TaskInputError'
}

export type CreateTaskInput = {
  date: string
  description: string | null
  endTime: string
  group: string | null
  name: string
  note: string | null
  priority: TaskPriority
  repeat: 'none'
  startTime: string
}

export type UpdateTaskInput = Partial<Pick<CreateTaskInput, 'description' | 'endTime' | 'group' | 'name' | 'note' | 'priority' | 'startTime'>>

export type TaskListInput = {
  from: string
  limit: number
  page: number
  to: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown) {
  if (!isRecord(value)) throw new TaskInputError('Dữ liệu công việc phải là một JSON object.')
  return value
}

function rejectUnknownFields(value: Record<string, unknown>, allowedFields: readonly string[]) {
  const allowed = new Set(allowedFields)
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown) throw new TaskInputError(`Trường ${unknown} không được hỗ trợ.`)
}

function requiredText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string') throw new TaskInputError(`${field} phải là chuỗi.`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) throw new TaskInputError(`${field} phải có từ 1 đến ${maxLength} ký tự.`)
  return normalized
}

function optionalText(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new TaskInputError(`${field} phải là chuỗi hoặc null.`)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new TaskInputError(`${field} không được vượt quá ${maxLength} ký tự.`)
  return normalized || null
}

function priority(value: unknown) {
  if (typeof value !== 'string' || !TASK_PRIORITIES.includes(value as TaskPriority)) {
    throw new TaskInputError('priority phải là low, normal hoặc high.')
  }
  return value as TaskPriority
}

function repeat(value: unknown) {
  if (value !== 'none') throw new TaskInputError('Chặng này chỉ hỗ trợ repeat="none".')
  return 'none' as const
}

function leapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

export function localDate(value: unknown, field = 'date') {
  if (typeof value !== 'string') throw new TaskInputError(`${field} phải có dạng YYYY-MM-DD.`)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new TaskInputError(`${field} phải có dạng YYYY-MM-DD.`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12) throw new TaskInputError(`${field} không phải ngày hợp lệ.`)
  const days = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (day < 1 || day > (days[month - 1] ?? 0)) throw new TaskInputError(`${field} không phải ngày hợp lệ.`)
  return value
}

export function localTime(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new TaskInputError(`${field} phải có dạng HH:mm.`)
  }
  return value
}

export function validateTimeOrder(startTime: string, endTime: string) {
  if (endTime <= startTime) throw new TaskInputError('endTime phải sau startTime trong cùng ngày.')
}

function dateDayNumber(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(0)
  value.setUTCHours(0, 0, 0, 0)
  value.setUTCFullYear(year, month - 1, day)
  return Math.floor(value.getTime() / 86_400_000)
}

function queryString(value: unknown, field: string) {
  if (typeof value !== 'string') throw new TaskInputError(`${field} phải xuất hiện đúng một lần.`)
  return value
}

function positiveInteger(value: unknown, field: string, fallback: number, maximum?: number) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new TaskInputError(`${field} phải là số nguyên dương.`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || (maximum !== undefined && parsed > maximum)) {
    throw new TaskInputError(`${field} phải từ 1${maximum ? ` đến ${maximum}` : ''}.`)
  }
  return parsed
}

export function validateCreateTask(value: unknown): CreateTaskInput {
  const body = record(value)
  rejectUnknownFields(body, ['date', 'name', 'startTime', 'endTime', 'priority', 'group', 'description', 'note', 'repeat'])
  const startTime = localTime(body.startTime, 'startTime')
  const endTime = localTime(body.endTime, 'endTime')
  validateTimeOrder(startTime, endTime)
  return {
    date: localDate(body.date),
    description: optionalText(body.description, 'description', TASK_DESCRIPTION_MAX_LENGTH),
    endTime,
    group: optionalText(body.group, 'group', TASK_GROUP_MAX_LENGTH),
    name: requiredText(body.name, 'name', TASK_NAME_MAX_LENGTH),
    note: optionalText(body.note, 'note', TASK_NOTE_MAX_LENGTH),
    priority: body.priority === undefined ? 'normal' : priority(body.priority),
    repeat: body.repeat === undefined ? 'none' : repeat(body.repeat),
    startTime,
  }
}

export function validateTaskUpdate(value: unknown): UpdateTaskInput {
  const body = record(value)
  rejectUnknownFields(body, ['name', 'startTime', 'endTime', 'priority', 'group', 'description', 'note'])
  if (Object.keys(body).length === 0) throw new TaskInputError('Cần gửi ít nhất một trường để sửa.')
  const output: UpdateTaskInput = {}
  if ('name' in body) output.name = requiredText(body.name, 'name', TASK_NAME_MAX_LENGTH)
  if ('startTime' in body) output.startTime = localTime(body.startTime, 'startTime')
  if ('endTime' in body) output.endTime = localTime(body.endTime, 'endTime')
  if ('priority' in body) output.priority = priority(body.priority)
  if ('group' in body) output.group = optionalText(body.group, 'group', TASK_GROUP_MAX_LENGTH)
  if ('description' in body) output.description = optionalText(body.description, 'description', TASK_DESCRIPTION_MAX_LENGTH)
  if ('note' in body) output.note = optionalText(body.note, 'note', TASK_NOTE_MAX_LENGTH)
  return output
}

export function validateDateChange(value: unknown) {
  const body = record(value)
  rejectUnknownFields(body, ['date'])
  return localDate(body.date)
}

export function validateCompletionChange(value: unknown) {
  const body = record(value)
  rejectUnknownFields(body, ['completed'])
  if (typeof body.completed !== 'boolean') throw new TaskInputError('completed phải là boolean true hoặc false.')
  return body.completed
}

export function validateTaskListQuery(value: unknown): TaskListInput {
  const query = record(value)
  rejectUnknownFields(query, ['date', 'from', 'to', 'page', 'limit'])
  const hasDate = query.date !== undefined
  const hasRange = query.from !== undefined || query.to !== undefined
  if (hasDate === hasRange) throw new TaskInputError('Chọn date hoặc cặp from/to, không dùng đồng thời.')

  let from: string
  let to: string
  if (hasDate) {
    from = localDate(queryString(query.date, 'date'))
    to = from
  } else {
    from = localDate(queryString(query.from, 'from'), 'from')
    to = localDate(queryString(query.to, 'to'), 'to')
    const rangeDays = dateDayNumber(to) - dateDayNumber(from) + 1
    if (rangeDays < 1) throw new TaskInputError('to phải bằng hoặc sau from.')
    if (rangeDays > TASK_RANGE_MAX_DAYS) throw new TaskInputError(`Khoảng ngày không được vượt quá ${TASK_RANGE_MAX_DAYS} ngày.`)
  }

  return {
    from,
    limit: positiveInteger(query.limit, 'limit', TASK_LIST_DEFAULT_LIMIT, TASK_LIST_MAX_LIMIT),
    page: positiveInteger(query.page, 'page', 1),
    to,
  }
}

export function validateSummaryQuery(value: unknown) {
  const query = record(value)
  rejectUnknownFields(query, ['date'])
  return localDate(queryString(query.date, 'date'))
}
