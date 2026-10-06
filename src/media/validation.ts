import { MediaInputError } from './errors.js'

export const MEDIA_MAX_IMAGES_PER_OWNER = 12
export const MEDIA_CAPTION_MAX_LENGTH = 500

function integer(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new MediaInputError(`${field} phải là số nguyên dương.`)
  return value as number
}

export function mediaId(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{24}$/.test(value)) throw new MediaInputError('ID ảnh không hợp lệ.')
  return value
}

export function clientUploadId(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new MediaInputError('clientUploadId phải là UUID hợp lệ.')
  }
  return value.toLowerCase()
}

export function mediaCaption(value: unknown) {
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new MediaInputError('caption phải là chuỗi.')
  if (value.length > MEDIA_CAPTION_MAX_LENGTH) throw new MediaInputError(`caption không được vượt quá ${MEDIA_CAPTION_MAX_LENGTH} ký tự.`)
  return value
}

export function multipartJournalVersion(value: unknown) {
  if (value === 'null') return null
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new MediaInputError('version phải là số nguyên dương hoặc null.')
  return integer(Number(value), 'version')
}

function record(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MediaInputError('Dữ liệu ảnh phải là một JSON object.')
  return value as Record<string, unknown>
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[]) {
  const fields = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !fields.has(key))
  if (unknown) throw new MediaInputError(`Trường ${unknown} không được hỗ trợ.`)
}

export type UpdateCaptionInput = {
  caption: string
  journalVersion?: number
  version: number
}

export function validateUpdateCaption(value: unknown): UpdateCaptionInput {
  const body = record(value)
  rejectUnknownFields(body, ['caption', 'version', 'journalVersion'])
  if (!('caption' in body)) throw new MediaInputError('caption là bắt buộc.')
  return {
    caption: mediaCaption(body.caption),
    journalVersion: body.journalVersion === undefined ? undefined : integer(body.journalVersion, 'journalVersion'),
    version: integer(body.version, 'version'),
  }
}

export type DeleteMediaInput = {
  journalVersion?: number
  version: number
}

export function validateDeleteMedia(value: unknown): DeleteMediaInput {
  const body = record(value)
  rejectUnknownFields(body, ['version', 'journalVersion'])
  return {
    journalVersion: body.journalVersion === undefined ? undefined : integer(body.journalVersion, 'journalVersion'),
    version: integer(body.version, 'version'),
  }
}
