import express, { type NextFunction, type Request, type Response } from 'express'
import { deleteJournal, getJournal, JournalConflictError, JournalNotFoundError, listJournals, saveJournal } from '../journals/service.js'
import { JournalInputError, journalDate, validateDeleteJournal, validateJournalListQuery, validateSaveJournal } from '../journals/validation.js'
import { requireAuthentication } from '../middleware/authentication.js'
import { requireAllowedOrigin, requireJson } from '../middleware/requestSecurity.js'

type JournalRouterOptions = {
  frontendOrigin: string
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

export function createJournalRouter({ frontendOrigin }: JournalRouterOptions) {
  const router = express.Router()
  const parseJson = express.json({ limit: '96kb' })
  const writeSecurity = [requireAllowedOrigin(frontendOrigin), requireJson, parseJson]

  router.use(requireAuthentication)

  router.get('/', asyncHandler(async (request, response) => {
    response.json(await listJournals(authenticatedUserId(request), validateJournalListQuery(request.query)))
  }))

  router.get('/:date', asyncHandler(async (request, response) => {
    response.json({ journal: await getJournal(authenticatedUserId(request), journalDate(request.params.date)) })
  }))

  router.put('/:date', ...writeSecurity, asyncHandler(async (request, response) => {
    const result = await saveJournal(
      authenticatedUserId(request),
      journalDate(request.params.date),
      validateSaveJournal(request.body),
    )
    response.status(result.created ? 201 : 200).json({ journal: result.journal })
  }))

  router.delete('/:date', ...writeSecurity, asyncHandler(async (request, response) => {
    await deleteJournal(
      authenticatedUserId(request),
      journalDate(request.params.date),
      validateDeleteJournal(request.body),
    )
    response.status(204).end()
  }))

  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error instanceof JournalInputError) {
      response.status(400).json({ error: error.message })
      return
    }
    if (error instanceof JournalNotFoundError) {
      response.status(404).json({ error: error.message })
      return
    }
    if (error instanceof JournalConflictError) {
      response.status(409).json({ error: error.message })
      return
    }
    next(error)
  })

  return router
}
