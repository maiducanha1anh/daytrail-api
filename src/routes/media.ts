import express, { type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import { JournalInputError, journalDate } from '../journals/validation.js'
import { requireAuthentication } from '../middleware/authentication.js'
import { requireAllowedOrigin, requireJson } from '../middleware/requestSecurity.js'
import {
  MediaConflictError,
  MediaInputError,
  MediaNotFoundError,
  MediaStorageUnavailableError,
  MediaTooLargeError,
  MediaUnsupportedTypeError,
  MediaUploadBusyError,
} from '../media/errors.js'
import { MEDIA_MAX_FILE_BYTES } from '../media/image.js'
import { deleteMedia, listMedia, readMedia, updateMediaCaption, uploadMedia } from '../media/service.js'
import type { MediaStorage } from '../media/storage.js'
import { clientUploadId, mediaCaption, mediaId, multipartJournalVersion, validateDeleteMedia, validateUpdateCaption } from '../media/validation.js'
import { validateTaskId, TaskNotFoundError } from '../tasks/service.js'
import { TaskInputError } from '../tasks/validation.js'

type MediaRouterOptions = {
  frontendOrigin: string
  keyPrefix?: string
  storage?: MediaStorage
  uploadConcurrency: number
}

type AsyncHandler = (request: Request, response: Response) => Promise<void>

function asyncHandler(handler: AsyncHandler) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next)
  }
}

function authenticatedUserId(request: Request) {
  if (!request.auth?.userId) throw new Error('Authenticated request is missing userId')
  return request.auth.userId
}

function configuredStorage(options: MediaRouterOptions) {
  if (!options.storage || !options.keyPrefix) throw new MediaStorageUnavailableError('Kho ảnh chưa được cấu hình.')
  return { keyPrefix: options.keyPrefix, storage: options.storage }
}

function requireMultipart(request: Request, response: Response, next: NextFunction) {
  if (!request.is('multipart/form-data')) {
    response.status(415).json({ error: 'Content-Type phải là multipart/form-data.' })
    return
  }
  next()
}

function createUploadConcurrencyGuard(maximum: number) {
  let active = 0
  return (_request: Request, response: Response, next: NextFunction) => {
    if (active >= maximum) {
      next(new MediaUploadBusyError('Đang có quá nhiều ảnh được xử lý. Hãy thử lại sau.'))
      return
    }
    active += 1
    let released = false
    const release = () => {
      if (released) return
      released = true
      active -= 1
    }
    response.once('finish', release)
    response.once('close', release)
    next()
  }
}

const multipart = multer({
  limits: {
    fieldNameSize: 64,
    fieldSize: 2_048,
    fields: 4,
    fileSize: MEDIA_MAX_FILE_BYTES,
    files: 1,
    parts: 5,
  },
  storage: multer.memoryStorage(),
})

function parseSingleImage(request: Request, response: Response, next: NextFunction) {
  request.setTimeout(30_000)
  multipart.single('file')(request, response, next)
}

function uploadFields(request: Request) {
  if (!request.file) throw new MediaInputError('Trường file là bắt buộc và chỉ nhận một ảnh.')
  return {
    caption: mediaCaption(request.body?.caption),
    clientUploadId: clientUploadId(request.body?.clientUploadId),
    file: request.file.buffer,
  }
}

function mediaErrorHandler(error: unknown, _request: Request, response: Response, next: NextFunction) {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') response.status(413).json({ error: 'Mỗi ảnh không được vượt quá 8 MiB.' })
    else response.status(400).json({ error: 'Form upload ảnh không hợp lệ hoặc có quá nhiều trường/file.' })
    return
  }
  if (error instanceof MediaTooLargeError) {
    response.status(413).json({ error: error.message })
    return
  }
  if (error instanceof MediaUnsupportedTypeError) {
    response.status(415).json({ error: error.message })
    return
  }
  if (error instanceof MediaInputError || error instanceof TaskInputError || error instanceof JournalInputError) {
    response.status(400).json({ error: error.message })
    return
  }
  if (error instanceof MediaConflictError) {
    response.status(409).json({ error: error.message })
    return
  }
  if (error instanceof MediaNotFoundError || error instanceof TaskNotFoundError) {
    response.status(404).json({ error: error.message })
    return
  }
  if (error instanceof MediaStorageUnavailableError) {
    response.set('Retry-After', '5').status(503).json({
      code: 'MEDIA_STORAGE_UNAVAILABLE',
      error: 'Kho ảnh tạm thời không sẵn sàng. Vui lòng thử lại sau.',
    })
    return
  }
  if (error instanceof MediaUploadBusyError) {
    response.set('Retry-After', '5').status(429).json({ error: error.message })
    return
  }
  next(error)
}

export function createTaskMediaRouter(options: MediaRouterOptions) {
  const router = express.Router()
  const uploadGuard = createUploadConcurrencyGuard(options.uploadConcurrency)
  router.use(requireAuthentication)
  router.get('/:taskId/images', asyncHandler(async (request, response) => {
    configuredStorage(options)
    const result = await listMedia(authenticatedUserId(request), 'task', validateTaskId(request.params.taskId))
    response.json({ images: result.images })
  }))
  router.post(
    '/:taskId/images',
    requireAllowedOrigin(options.frontendOrigin),
    requireMultipart,
    uploadGuard,
    parseSingleImage,
    asyncHandler(async (request, response) => {
      const { keyPrefix, storage } = configuredStorage(options)
      const fields = uploadFields(request)
      const result = await uploadMedia(storage, {
        ...fields,
        keyPrefix,
        ownerKey: validateTaskId(request.params.taskId),
        ownerType: 'task',
        userId: authenticatedUserId(request),
      })
      response.status(result.created ? 201 : 200).json({ image: result.image })
    }),
  )
  router.use(mediaErrorHandler)
  return router
}

export function createJournalMediaRouter(options: MediaRouterOptions) {
  const router = express.Router()
  const uploadGuard = createUploadConcurrencyGuard(options.uploadConcurrency)
  router.use(requireAuthentication)
  router.get('/:date/images', asyncHandler(async (request, response) => {
    configuredStorage(options)
    const result = await listMedia(authenticatedUserId(request), 'journal', journalDate(request.params.date))
    response.json({ images: result.images, journalVersion: result.journalVersion })
  }))
  router.post(
    '/:date/images',
    requireAllowedOrigin(options.frontendOrigin),
    requireMultipart,
    uploadGuard,
    parseSingleImage,
    asyncHandler(async (request, response) => {
      const { keyPrefix, storage } = configuredStorage(options)
      const fields = uploadFields(request)
      const result = await uploadMedia(storage, {
        ...fields,
        journalVersion: multipartJournalVersion(request.body?.version),
        keyPrefix,
        ownerKey: journalDate(request.params.date),
        ownerType: 'journal',
        userId: authenticatedUserId(request),
      })
      response.status(result.created ? 201 : 200).json({
        image: result.image,
        journalVersion: result.journalVersion,
      })
    }),
  )
  router.use(mediaErrorHandler)
  return router
}

export function createImageRouter(options: MediaRouterOptions) {
  const router = express.Router()
  const parseJson = express.json({ limit: '16kb' })
  router.use(requireAuthentication)
  router.get('/:imageId/file', asyncHandler(async (request, response) => {
    const { storage } = configuredStorage(options)
    if (request.query.variant !== 'full' && request.query.variant !== 'thumbnail') throw new MediaInputError('variant phải là full hoặc thumbnail.')
    const object = await readMedia(storage, authenticatedUserId(request), mediaId(request.params.imageId), request.query.variant)
    response
      .set('Cache-Control', 'private, no-store')
      .set('Content-Type', object.contentType)
      .set('Content-Disposition', 'inline')
      .set('X-Content-Type-Options', 'nosniff')
      .send(object.body)
  }))
  router.patch('/:imageId', requireAllowedOrigin(options.frontendOrigin), requireJson, parseJson, asyncHandler(async (request, response) => {
    configuredStorage(options)
    response.json(await updateMediaCaption(authenticatedUserId(request), mediaId(request.params.imageId), validateUpdateCaption(request.body)))
  }))
  router.delete('/:imageId', requireAllowedOrigin(options.frontendOrigin), requireJson, parseJson, asyncHandler(async (request, response) => {
    const { storage } = configuredStorage(options)
    const result = await deleteMedia(storage, authenticatedUserId(request), mediaId(request.params.imageId), validateDeleteMedia(request.body))
    response.status(result.cleanupPending ? 202 : 200).json({
      cleanupStatus: result.cleanupPending ? 'pending' : 'deleted',
      journalVersion: result.journalVersion,
    })
  }))
  router.use(mediaErrorHandler)
  return router
}
