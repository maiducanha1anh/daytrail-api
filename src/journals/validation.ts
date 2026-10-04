export const JOURNAL_CONTENT_MAX_LENGTH = 20_000
export const JOURNAL_EXCERPT_MAX_LENGTH = 160
export const JOURNAL_LIST_DEFAULT_LIMIT = 20
export const JOURNAL_LIST_MAX_LIMIT = 100
export const JOURNAL_RANGE_MAX_DAYS = 366

export class JournalInputError extends Error {
  override name = 'JournalInputError'
}

export type SaveJournalInput = {
  content: string
  version: number | null
}

export type JournalListInput = {
  from: string
  limit: number
  page: number
  to: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown) {
  if (!isRecord(value)) throw new JournalInputError('Dữ liệu nhật ký phải là một JSON object.')
  return value
}

function rejectUnknownFields(value: Record<string, unknown>, allowedFields: readonly string[]) {
  const allowed = new Set(allowedFields)
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown) throw new JournalInputError(`Trường ${unknown} không được hỗ trợ.`)
}

function leapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

export function journalDate(value: unknown, field = 'date') {
  if (typeof value !== 'string') throw new JournalInputError(`${field} phải có dạng YYYY-MM-DD.`)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new JournalInputError(`${field} phải có dạng YYYY-MM-DD.`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12) throw new JournalInputError(`${field} không phải ngày hợp lệ.`)
  const days = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (day < 1 || day > (days[month - 1] ?? 0)) throw new JournalInputError(`${field} không phải ngày hợp lệ.`)
  return value
}

function dateDayNumber(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(0)
  value.setUTCHours(0, 0, 0, 0)
  value.setUTCFullYear(year, month - 1, day)
  return Math.floor(value.getTime() / 86_400_000)
}

function queryString(value: unknown, field: string) {
  if (typeof value !== 'string') throw new JournalInputError(`${field} phải xuất hiện đúng một lần.`)
  return value
}

function positiveInteger(value: unknown, field: string, fallback: number, maximum?: number) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new JournalInputError(`${field} phải là số nguyên dương.`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || (maximum !== undefined && parsed > maximum)) {
    throw new JournalInputError(`${field} phải từ 1${maximum ? ` đến ${maximum}` : ''}.`)
  }
  return parsed
}

function journalVersion(value: unknown, allowNull: true): number | null
function journalVersion(value: unknown, allowNull: false): number
function journalVersion(value: unknown, allowNull: boolean): number | null {
  if (allowNull && value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new JournalInputError('version phải là số nguyên dương.')
  return value as number
}

export function validateSaveJournal(value: unknown): SaveJournalInput {
  const body = record(value)
  rejectUnknownFields(body, ['content', 'version'])
  if (!('content' in body) || typeof body.content !== 'string') throw new JournalInputError('content phải là chuỗi.')
  if (!body.content.trim()) throw new JournalInputError('content không được chỉ chứa khoảng trắng.')
  if (body.content.length > JOURNAL_CONTENT_MAX_LENGTH) {
    throw new JournalInputError(`content không được vượt quá ${JOURNAL_CONTENT_MAX_LENGTH} ký tự.`)
  }
  if (!('version' in body)) throw new JournalInputError('version là bắt buộc; dùng null khi tạo mới.')
  return { content: body.content, version: journalVersion(body.version, true) }
}

export function validateDeleteJournal(value: unknown) {
  const body = record(value)
  rejectUnknownFields(body, ['version'])
  if (!('version' in body)) throw new JournalInputError('version là bắt buộc.')
  return journalVersion(body.version, false)
}

export function validateJournalListQuery(value: unknown): JournalListInput {
  const query = record(value)
  rejectUnknownFields(query, ['from', 'to', 'page', 'limit'])
  const from = journalDate(queryString(query.from, 'from'), 'from')
  const to = journalDate(queryString(query.to, 'to'), 'to')
  const rangeDays = dateDayNumber(to) - dateDayNumber(from) + 1
  if (rangeDays < 1) throw new JournalInputError('to phải bằng hoặc sau from.')
  if (rangeDays > JOURNAL_RANGE_MAX_DAYS) throw new JournalInputError(`Khoảng nhật ký không được vượt quá ${JOURNAL_RANGE_MAX_DAYS} ngày.`)
  return {
    from,
    limit: positiveInteger(query.limit, 'limit', JOURNAL_LIST_DEFAULT_LIMIT, JOURNAL_LIST_MAX_LIMIT),
    page: positiveInteger(query.page, 'page', 1),
    to,
  }
}
