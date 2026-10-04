import express, { type NextFunction, type Request, type Response } from 'express'
import { requireAuthentication } from '../middleware/authentication.js'
import { requireAllowedOrigin, requireJson } from '../middleware/requestSecurity.js'
import { createTask, deleteTask, getTask, listTasks, moveTask, setTaskCompletion, taskSummaries, taskSummary, TaskNotFoundError, updateTask, validateTaskId } from '../tasks/service.js'
import { TaskInputError, validateCompletionChange, validateCreateTask, validateDateChange, validateSummaryQuery, validateSummaryRangeQuery, validateTaskListQuery, validateTaskUpdate } from '../tasks/validation.js'

type TaskRouterOptions = {
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

export function createTaskRouter({ frontendOrigin }: TaskRouterOptions) {
  const router = express.Router()
  const parseJson = express.json({ limit: '32kb' })
  const writeSecurity = [requireAllowedOrigin(frontendOrigin), requireJson, parseJson]

  router.use(requireAuthentication)

  router.get('/', asyncHandler(async (request, response) => {
    response.json(await listTasks(authenticatedUserId(request), validateTaskListQuery(request.query)))
  }))

  router.get('/summary', asyncHandler(async (request, response) => {
    response.json(await taskSummary(authenticatedUserId(request), validateSummaryQuery(request.query)))
  }))

  router.get('/summaries', asyncHandler(async (request, response) => {
    response.json(await taskSummaries(authenticatedUserId(request), validateSummaryRangeQuery(request.query)))
  }))

  router.post('/', ...writeSecurity, asyncHandler(async (request, response) => {
    response.status(201).json({ task: await createTask(authenticatedUserId(request), validateCreateTask(request.body)) })
  }))

  router.get('/:id', asyncHandler(async (request, response) => {
    response.json({ task: await getTask(authenticatedUserId(request), validateTaskId(request.params.id)) })
  }))

  router.patch('/:id', ...writeSecurity, asyncHandler(async (request, response) => {
    response.json({ task: await updateTask(authenticatedUserId(request), validateTaskId(request.params.id), validateTaskUpdate(request.body)) })
  }))

  router.patch('/:id/date', ...writeSecurity, asyncHandler(async (request, response) => {
    response.json({ task: await moveTask(authenticatedUserId(request), validateTaskId(request.params.id), validateDateChange(request.body)) })
  }))

  router.patch('/:id/completion', ...writeSecurity, asyncHandler(async (request, response) => {
    response.json({ task: await setTaskCompletion(authenticatedUserId(request), validateTaskId(request.params.id), validateCompletionChange(request.body)) })
  }))

  router.delete('/:id', ...writeSecurity, asyncHandler(async (request, response) => {
    await deleteTask(authenticatedUserId(request), validateTaskId(request.params.id))
    response.status(204).end()
  }))

  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error instanceof TaskInputError) {
      response.status(400).json({ error: error.message })
      return
    }
    if (error instanceof TaskNotFoundError) {
      response.status(404).json({ error: error.message })
      return
    }
    next(error)
  })

  return router
}
