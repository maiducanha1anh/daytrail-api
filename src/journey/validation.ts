export const JOURNEY_RANGE_MAX_DAYS = 366
export const JOURNEY_LIST_DEFAULT_LIMIT = 20
export const JOURNEY_LIST_MAX_LIMIT = 50
export const JOURNEY_ALBUM_TITLE_MAX_LENGTH = 100
export const JOURNEY_PHASE_NAME_MAX_LENGTH = 120
export const JOURNEY_PHASE_INTRODUCTION_MAX_LENGTH = 2_000
export const JOURNEY_PHASE_SUMMARY_MAX_LENGTH = 5_000

export class JourneyInputError extends Error {
  override name = 'JourneyInputError'
}

export type JourneyTimelineInput = { from: string; limit: number; page: number; to: string }
export type JourneyHighlightInput = { sourceId: string; sourceType: 'journal' }
export type JourneyAlbumInput = { coverImageId: string | null; title: string }
export type JourneyPhaseInput = {
  coverImageId: string | null
  endDate: string
  introduction: string
  name: string
  startDate: string
  summary: string
}
export type JourneyPhaseUpdateInput = Partial<JourneyPhaseInput>

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown) {
  if (!isRecord(value)) throw new JourneyInputError('Dữ liệu Hành trình phải là một JSON object.')
  return value
}

function rejectUnknownFields(value: Record<string, unknown>, allowedFields: readonly string[]) {
  const allowed = new Set(allowedFields)
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown) throw new JourneyInputError(`Trường ${unknown} không được hỗ trợ.`)
}

function leapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

export function journeyDate(value: unknown, field = 'date') {
  if (typeof value !== 'string') throw new JourneyInputError(`${field} phải có dạng YYYY-MM-DD.`)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new JourneyInputError(`${field} phải có dạng YYYY-MM-DD.`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12) throw new JourneyInputError(`${field} không phải ngày hợp lệ.`)
  const days = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (day < 1 || day > (days[month - 1] ?? 0)) throw new JourneyInputError(`${field} không phải ngày hợp lệ.`)
  return value
}

function dayNumber(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(0)
  value.setUTCHours(0, 0, 0, 0)
  value.setUTCFullYear(year, month - 1, day)
  return Math.floor(value.getTime() / 86_400_000)
}

function positiveInteger(value: unknown, field: string, fallback: number, maximum: number) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new JourneyInputError(`${field} phải là số nguyên dương.`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new JourneyInputError(`${field} phải từ 1 đến ${maximum}.`)
  }
  return parsed
}

function queryString(value: unknown, field: string) {
  if (typeof value !== 'string') throw new JourneyInputError(`${field} phải xuất hiện đúng một lần.`)
  return value
}

function objectId(value: unknown, field: string, allowNull = false) {
  if (allowNull && value === null) return null
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{24}$/.test(value)) throw new JourneyInputError(`${field} không hợp lệ.`)
  return value
}

function requiredText(value: unknown, field: string, maximum: number) {
  if (typeof value !== 'string') throw new JourneyInputError(`${field} phải là chuỗi.`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) throw new JourneyInputError(`${field} phải có từ 1 đến ${maximum} ký tự.`)
  return normalized
}

function text(value: unknown, field: string, maximum: number) {
  if (typeof value !== 'string') throw new JourneyInputError(`${field} phải là chuỗi.`)
  if (value.length > maximum) throw new JourneyInputError(`${field} không được vượt quá ${maximum} ký tự.`)
  return value
}

function validateDateOrder(startDate: string, endDate: string) {
  if (endDate < startDate) throw new JourneyInputError('endDate phải bằng hoặc sau startDate.')
}

export function validateJourneyYear(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}$/.test(value)) throw new JourneyInputError('year phải có 4 chữ số.')
  const year = Number(value)
  if (year < 1 || year > 9999) throw new JourneyInputError('year không hợp lệ.')
  return year
}

export function validateJourneyMonth(value: unknown) {
  if (typeof value !== 'string' || !/^\d{1,2}$/.test(value)) throw new JourneyInputError('month phải từ 1 đến 12.')
  const month = Number(value)
  if (month < 1 || month > 12) throw new JourneyInputError('month phải từ 1 đến 12.')
  return month
}

export function validateJourneyTimelineQuery(value: unknown): JourneyTimelineInput {
  const query = record(value)
  rejectUnknownFields(query, ['from', 'to', 'page', 'limit'])
  const from = journeyDate(queryString(query.from, 'from'), 'from')
  const to = journeyDate(queryString(query.to, 'to'), 'to')
  const rangeDays = dayNumber(to) - dayNumber(from) + 1
  if (rangeDays < 1) throw new JourneyInputError('to phải bằng hoặc sau from.')
  if (rangeDays > JOURNEY_RANGE_MAX_DAYS) throw new JourneyInputError(`Khoảng Hành trình không được vượt quá ${JOURNEY_RANGE_MAX_DAYS} ngày.`)
  return {
    from,
    limit: positiveInteger(query.limit, 'limit', JOURNEY_LIST_DEFAULT_LIMIT, JOURNEY_LIST_MAX_LIMIT),
    page: positiveInteger(query.page, 'page', 1, 10_000),
    to,
  }
}

export function validateJourneyHighlight(value: unknown): JourneyHighlightInput {
  const body = record(value)
  rejectUnknownFields(body, ['sourceType', 'sourceId'])
  if (body.sourceType !== 'journal') throw new JourneyInputError('Hành trình chỉ cho phép đánh dấu nhật ký.')
  return { sourceId: objectId(body.sourceId, 'sourceId') as string, sourceType: 'journal' }
}

export function validateJourneyAlbum(value: unknown): JourneyAlbumInput {
  const body = record(value)
  rejectUnknownFields(body, ['title', 'coverImageId'])
  if (typeof body.title !== 'string' || body.title.length > JOURNEY_ALBUM_TITLE_MAX_LENGTH) {
    throw new JourneyInputError(`title không được vượt quá ${JOURNEY_ALBUM_TITLE_MAX_LENGTH} ký tự.`)
  }
  return {
    coverImageId: objectId(body.coverImageId, 'coverImageId', true),
    title: body.title.trim(),
  }
}

export function validateJourneyDate(value: unknown) {
  return journeyDate(value, 'date')
}

export function validateJourneyPagination(value: unknown) {
  const query = record(value)
  rejectUnknownFields(query, ['page', 'limit'])
  return {
    limit: positiveInteger(query.limit, 'limit', JOURNEY_LIST_DEFAULT_LIMIT, JOURNEY_LIST_MAX_LIMIT),
    page: positiveInteger(query.page, 'page', 1, 10_000),
  }
}

export function validateJourneyCoverQuery(value: unknown): JourneyTimelineInput {
  const query = record(value)
  rejectUnknownFields(query, ['from', 'to', 'page', 'limit'])
  const from = journeyDate(queryString(query.from, 'from'), 'from')
  const to = journeyDate(queryString(query.to, 'to'), 'to')
  if (to < from) throw new JourneyInputError('to phải bằng hoặc sau from.')
  return {
    from,
    limit: positiveInteger(query.limit, 'limit', JOURNEY_LIST_DEFAULT_LIMIT, JOURNEY_LIST_MAX_LIMIT),
    page: positiveInteger(query.page, 'page', 1, 10_000),
    to,
  }
}

function phaseFields(body: Record<string, unknown>, partial: boolean): JourneyPhaseUpdateInput {
  const output: JourneyPhaseUpdateInput = {}
  if (!partial || 'name' in body) output.name = requiredText(body.name, 'name', JOURNEY_PHASE_NAME_MAX_LENGTH)
  if (!partial || 'startDate' in body) output.startDate = journeyDate(body.startDate, 'startDate')
  if (!partial || 'endDate' in body) output.endDate = journeyDate(body.endDate, 'endDate')
  if (!partial || 'coverImageId' in body) output.coverImageId = objectId(body.coverImageId, 'coverImageId', true)
  if (!partial || 'introduction' in body) output.introduction = text(body.introduction, 'introduction', JOURNEY_PHASE_INTRODUCTION_MAX_LENGTH)
  if (!partial || 'summary' in body) output.summary = text(body.summary, 'summary', JOURNEY_PHASE_SUMMARY_MAX_LENGTH)
  if (output.startDate && output.endDate) validateDateOrder(output.startDate, output.endDate)
  return output
}

export function validateCreateJourneyPhase(value: unknown): JourneyPhaseInput {
  const body = record(value)
  rejectUnknownFields(body, ['name', 'startDate', 'endDate', 'coverImageId', 'introduction', 'summary'])
  return phaseFields(body, false) as JourneyPhaseInput
}

export function validateUpdateJourneyPhase(value: unknown): JourneyPhaseUpdateInput {
  const body = record(value)
  rejectUnknownFields(body, ['name', 'startDate', 'endDate', 'coverImageId', 'introduction', 'summary'])
  if (Object.keys(body).length === 0) throw new JourneyInputError('Cần gửi ít nhất một trường để sửa giai đoạn.')
  return phaseFields(body, true)
}

export function validateJourneyPhaseId(value: unknown) {
  return objectId(value, 'ID giai đoạn') as string
}

export function validateJourneyHighlightId(value: unknown) {
  return objectId(value, 'ID khoảnh khắc') as string
}
