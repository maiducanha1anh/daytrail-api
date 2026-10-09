import express, { type NextFunction, type Request, type Response } from 'express'
import {
  createJourneyHighlight,
  createJourneyPhase,
  deleteJourneyHighlight,
  deleteJourneyPhase,
  journeyCoverOptions,
  journeyDay,
  journeyDays,
  journeyMonth,
  journeyPhaseDays,
  journeyYear,
  JourneyNotFoundError,
  listJourneyPhases,
  updateJourneyAlbum,
  updateJourneyPhase,
} from '../journey/service.js'
import {
  JourneyInputError,
  validateJourneyAlbum,
  validateJourneyCoverQuery,
  validateJourneyDate,
  validateCreateJourneyPhase,
  validateJourneyHighlight,
  validateJourneyHighlightId,
  validateJourneyMonth,
  validateJourneyPagination,
  validateJourneyPhaseId,
  validateJourneyTimelineQuery,
  validateUpdateJourneyPhase,
  validateJourneyYear,
} from '../journey/validation.js'
import { requireAuthentication } from '../middleware/authentication.js'
import { requireAllowedOrigin, requireJson } from '../middleware/requestSecurity.js'

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

export function createJourneyRouter(frontendOrigin: string) {
  const router = express.Router()
  const parseJson = express.json({ limit: '32kb' })
  const writeSecurity = [requireAllowedOrigin(frontendOrigin), requireJson, parseJson]

  router.use(requireAuthentication)

  router.get('/year/:year', asyncHandler(async (request, response) => {
    response.json(await journeyYear(authenticatedUserId(request), validateJourneyYear(request.params.year)))
  }))

  router.get('/month/:year/:month', asyncHandler(async (request, response) => {
    response.json(await journeyMonth(
      authenticatedUserId(request),
      validateJourneyYear(request.params.year),
      validateJourneyMonth(request.params.month),
    ))
  }))

  router.put('/albums/:year/:month', ...writeSecurity, asyncHandler(async (request, response) => {
    response.json(await updateJourneyAlbum(
      authenticatedUserId(request),
      validateJourneyYear(request.params.year),
      validateJourneyMonth(request.params.month),
      validateJourneyAlbum(request.body),
    ))
  }))

  router.get('/days', asyncHandler(async (request, response) => {
    response.json(await journeyDays(authenticatedUserId(request), validateJourneyTimelineQuery(request.query)))
  }))

  router.get('/days/:date', asyncHandler(async (request, response) => {
    response.json(await journeyDay(authenticatedUserId(request), validateJourneyDate(request.params.date)))
  }))

  router.get('/covers', asyncHandler(async (request, response) => {
    response.json(await journeyCoverOptions(authenticatedUserId(request), validateJourneyCoverQuery(request.query)))
  }))

  router.post('/highlights', ...writeSecurity, asyncHandler(async (request, response) => {
    const result = await createJourneyHighlight(authenticatedUserId(request), validateJourneyHighlight(request.body))
    response.status(result.created ? 201 : 200).json({ highlight: result.highlight })
  }))

  router.delete('/highlights/:highlightId', ...writeSecurity, asyncHandler(async (request, response) => {
    await deleteJourneyHighlight(authenticatedUserId(request), validateJourneyHighlightId(request.params.highlightId))
    response.status(204).end()
  }))

  router.get('/phases', asyncHandler(async (request, response) => {
    response.json(await listJourneyPhases(authenticatedUserId(request)))
  }))

  router.get('/phases/:phaseId/days', asyncHandler(async (request, response) => {
    const page = validateJourneyPagination(request.query)
    response.json(await journeyPhaseDays(
      authenticatedUserId(request),
      validateJourneyPhaseId(request.params.phaseId),
      page.page,
      page.limit,
    ))
  }))

  router.post('/phases', ...writeSecurity, asyncHandler(async (request, response) => {
    response.status(201).json({ phase: await createJourneyPhase(authenticatedUserId(request), validateCreateJourneyPhase(request.body)) })
  }))

  router.patch('/phases/:phaseId', ...writeSecurity, asyncHandler(async (request, response) => {
    response.json({ phase: await updateJourneyPhase(
      authenticatedUserId(request),
      validateJourneyPhaseId(request.params.phaseId),
      validateUpdateJourneyPhase(request.body),
    ) })
  }))

  router.delete('/phases/:phaseId', ...writeSecurity, asyncHandler(async (request, response) => {
    await deleteJourneyPhase(authenticatedUserId(request), validateJourneyPhaseId(request.params.phaseId))
    response.status(204).end()
  }))

  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error instanceof JourneyInputError) {
      response.status(400).json({ error: error.message })
      return
    }
    if (error instanceof JourneyNotFoundError) {
      response.status(404).json({ error: error.message })
      return
    }
    next(error)
  })

  return router
}
