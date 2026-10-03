import type { NextFunction, Request, Response } from 'express'

export function requireJson(request: Request, response: Response, next: NextFunction) {
  if (!request.is('application/json')) {
    response.status(415).json({ error: 'Content-Type phải là application/json.' })
    return
  }
  next()
}

export function requireAllowedOrigin(frontendOrigin: string) {
  return (request: Request, response: Response, next: NextFunction) => {
    const origin = request.get('origin')
    const fetchSite = request.get('sec-fetch-site')
    if ((origin && origin !== frontendOrigin) || (!origin && fetchSite === 'cross-site')) {
      response.status(403).json({ error: 'Origin không được phép.' })
      return
    }
    next()
  }
}
