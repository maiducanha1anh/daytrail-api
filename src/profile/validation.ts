import type { ProfileImageRole } from '../models/ProfileImage.js'
import { ProfileInputError } from './errors.js'

export const PROFILE_DISPLAY_NAME_MAX_LENGTH = 80
export const PROFILE_TAGLINE_MAX_LENGTH = 160
export const PROFILE_ABOUT_MAX_LENGTH = 3_000
export const PROFILE_ASPIRATION_MAX_LENGTH = 2_000
export const PROFILE_IMAGE_CAPTION_MAX_LENGTH = 200
export const PROFILE_DECORATION_MAX_IMAGES = 4

function record(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProfileInputError('Dữ liệu hồ sơ phải là một JSON object.')
  return value as Record<string, unknown>
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[]) {
  const fields = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !fields.has(key))
  if (unknown) throw new ProfileInputError(`Trường ${unknown} không được hỗ trợ.`)
}

function text(value: unknown, field: string, maximum: number, required = false) {
  if (typeof value !== 'string') throw new ProfileInputError(`${field} phải là chuỗi.`)
  if (value.length > maximum) throw new ProfileInputError(`${field} không được vượt quá ${maximum} ký tự.`)
  const normalized = field === 'displayName' ? value.trim() : value
  if (required && !normalized) throw new ProfileInputError(`${field} không được để trống.`)
  return normalized
}

function objectId(value: unknown, field: string, nullable = false) {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{24}$/.test(value)) throw new ProfileInputError(`${field} không hợp lệ.`)
  return value
}

function version(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ProfileInputError('version phải là số nguyên không âm.')
  return value as number
}

export type UpdateProfileInput = {
  about: string
  aspiration: string
  avatarImageId: string | null
  captions: Record<string, string>
  decorationImageIds: string[]
  displayName: string
  tagline: string
  version: number
}

export function validateUpdateProfile(value: unknown): UpdateProfileInput {
  const body = record(value)
  rejectUnknownFields(body, ['displayName', 'tagline', 'about', 'aspiration', 'avatarImageId', 'decorationImageIds', 'captions', 'version'])
  if (!Array.isArray(body.decorationImageIds) || body.decorationImageIds.length > PROFILE_DECORATION_MAX_IMAGES) {
    throw new ProfileInputError(`decorationImageIds phải là mảng tối đa ${PROFILE_DECORATION_MAX_IMAGES} phần tử.`)
  }
  const decorationImageIds = body.decorationImageIds.map((value, index) => objectId(value, `decorationImageIds[${index}]`) as string)
  if (new Set(decorationImageIds).size !== decorationImageIds.length) throw new ProfileInputError('decorationImageIds không được lặp.')
  const captionsBody = record(body.captions)
  const captions: Record<string, string> = {}
  for (const [id, caption] of Object.entries(captionsBody)) {
    captions[objectId(id, 'ID ảnh trong captions') as string] = text(caption, 'caption', PROFILE_IMAGE_CAPTION_MAX_LENGTH)
  }
  const avatarImageId = objectId(body.avatarImageId, 'avatarImageId', true)
  const selectedIds = new Set([...(avatarImageId === null ? [] : [avatarImageId]), ...decorationImageIds])
  const unknownCaption = Object.keys(captions).find((id) => !selectedIds.has(id))
  if (unknownCaption) throw new ProfileInputError('captions chỉ được chứa ảnh đang chọn cho hồ sơ.')
  return {
    about: text(body.about, 'about', PROFILE_ABOUT_MAX_LENGTH),
    aspiration: text(body.aspiration, 'aspiration', PROFILE_ASPIRATION_MAX_LENGTH),
    avatarImageId,
    captions,
    decorationImageIds,
    displayName: text(body.displayName, 'displayName', PROFILE_DISPLAY_NAME_MAX_LENGTH, true),
    tagline: text(body.tagline, 'tagline', PROFILE_TAGLINE_MAX_LENGTH),
    version: version(body.version),
  }
}

export function validateProfileImageRole(value: unknown): ProfileImageRole {
  if (value !== 'avatar' && value !== 'decoration') throw new ProfileInputError('role phải là avatar hoặc decoration.')
  return value
}

export function validateProfileCaption(value: unknown) {
  if (value === undefined) return ''
  return text(value, 'caption', PROFILE_IMAGE_CAPTION_MAX_LENGTH)
}

export function validateProfileImageId(value: unknown) {
  return objectId(value, 'ID ảnh hồ sơ') as string
}

export function validateDiscardProfileImages(value: unknown) {
  const body = record(value)
  rejectUnknownFields(body, ['imageIds'])
  if (!Array.isArray(body.imageIds) || body.imageIds.length < 1 || body.imageIds.length > 10) {
    throw new ProfileInputError('imageIds phải có từ 1 đến 10 phần tử.')
  }
  const imageIds = body.imageIds.map((value, index) => objectId(value, `imageIds[${index}]`) as string)
  if (new Set(imageIds).size !== imageIds.length) throw new ProfileInputError('imageIds không được lặp.')
  return imageIds
}
