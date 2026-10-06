import { createHash } from 'node:crypto'
import sharp, { type Metadata } from 'sharp'
import { MediaInputError, MediaTooLargeError, MediaUnsupportedTypeError } from './errors.js'

export const MEDIA_MAX_FILE_BYTES = 8 * 1024 * 1024
export const MEDIA_MAX_INPUT_PIXELS = 20_000_000
export const MEDIA_FULL_MAX_EDGE = 2_560
export const MEDIA_THUMBNAIL_MAX_EDGE = 480
export const MEDIA_PROCESSING_TIMEOUT_SECONDS = 10
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp'])

export type ProcessedImage = {
  full: Buffer
  fullHeight: number
  fullWidth: number
  inputFormat: string
  thumbnail: Buffer
  thumbnailHeight: number
  thumbnailWidth: number
}

export function mediaPayloadHash(input: Buffer, caption: string) {
  return createHash('sha256').update(input).update('\0').update(caption, 'utf8').digest('hex')
}

export async function processImage(input: Buffer): Promise<ProcessedImage> {
  if (input.length === 0) throw new MediaInputError('File ảnh không được để trống.')
  if (input.length > MEDIA_MAX_FILE_BYTES) throw new MediaTooLargeError('Mỗi ảnh không được vượt quá 8 MiB.')

  let metadata: Metadata
  try {
    metadata = await sharp(input, {
      animated: true,
      failOn: 'warning',
      // Metadata only: inspect dimensions first so an oversized image receives
      // the explicit resource-limit response below. Decoding still enforces
      // MEDIA_MAX_INPUT_PIXELS in the processing pipeline.
      limitInputPixels: false,
    }).metadata()
  } catch {
    throw new MediaInputError('File ảnh bị hỏng hoặc không thể giải mã.')
  }
  if (!metadata.format || !ACCEPTED_FORMATS.has(metadata.format)) {
    throw new MediaUnsupportedTypeError('Chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP tĩnh.')
  }
  if ((metadata.pages ?? 1) > 1) throw new MediaUnsupportedTypeError('Ảnh động chưa được hỗ trợ.')
  if (!metadata.width || !metadata.height) throw new MediaInputError('Không đọc được kích thước ảnh.')
  if (metadata.width * metadata.height > MEDIA_MAX_INPUT_PIXELS) {
    throw new MediaTooLargeError(`Ảnh không được vượt quá ${MEDIA_MAX_INPUT_PIXELS.toLocaleString('vi-VN')} pixel.`)
  }

  try {
    const source = sharp(input, {
      animated: false,
      failOn: 'warning',
      limitInputPixels: MEDIA_MAX_INPUT_PIXELS,
    }).rotate()
    const [full, thumbnail] = await Promise.all([
      source.clone()
        .resize({ fit: 'inside', height: MEDIA_FULL_MAX_EDGE, width: MEDIA_FULL_MAX_EDGE, withoutEnlargement: true })
        .webp({ alphaQuality: 90, effort: 4, quality: 88 })
        .timeout({ seconds: MEDIA_PROCESSING_TIMEOUT_SECONDS })
        .toBuffer({ resolveWithObject: true }),
      source.clone()
        .resize({ fit: 'inside', height: MEDIA_THUMBNAIL_MAX_EDGE, width: MEDIA_THUMBNAIL_MAX_EDGE, withoutEnlargement: true })
        .webp({ alphaQuality: 85, effort: 4, quality: 80 })
        .timeout({ seconds: MEDIA_PROCESSING_TIMEOUT_SECONDS })
        .toBuffer({ resolveWithObject: true }),
    ])
    return {
      full: full.data,
      fullHeight: full.info.height,
      fullWidth: full.info.width,
      inputFormat: metadata.format,
      thumbnail: thumbnail.data,
      thumbnailHeight: thumbnail.info.height,
      thumbnailWidth: thumbnail.info.width,
    }
  } catch {
    throw new MediaInputError('Không thể xử lý ảnh an toàn. Hãy chọn file ảnh khác.')
  }
}
