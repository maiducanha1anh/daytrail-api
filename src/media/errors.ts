export class MediaInputError extends Error {
  override name = 'MediaInputError'
}

export class MediaUnsupportedTypeError extends Error {
  override name = 'MediaUnsupportedTypeError'
}

export class MediaTooLargeError extends Error {
  override name = 'MediaTooLargeError'
}

export class MediaConflictError extends Error {
  override name = 'MediaConflictError'
}

export class MediaNotFoundError extends Error {
  override name = 'MediaNotFoundError'
}

export class MediaStorageUnavailableError extends Error {
  override name = 'MediaStorageUnavailableError'
}

export class MediaUploadBusyError extends Error {
  override name = 'MediaUploadBusyError'
}
