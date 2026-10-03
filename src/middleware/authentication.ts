import type { NextFunction, Request, Response } from 'express'
import { hashSessionToken, SESSION_COOKIE_NAME } from '../auth/session.js'
import { Session } from '../models/Session.js'
import { User } from '../models/User.js'

const UNAUTHORIZED_MESSAGE = 'Bạn chưa đăng nhập hoặc phiên đã hết hạn.'

export async function requireAuthentication(request: Request, response: Response, next: NextFunction) {
  try {
    const token = request.cookies?.[SESSION_COOKIE_NAME]
    if (typeof token !== 'string' || !token) {
      response.status(401).json({ error: UNAUTHORIZED_MESSAGE })
      return
    }
    const tokenHash = hashSessionToken(token)
    const session = await Session.findOne({ tokenHash, expiresAt: { $gt: new Date() } })
    if (!session) {
      await Session.deleteOne({ tokenHash })
      response.status(401).json({ error: UNAUTHORIZED_MESSAGE })
      return
    }
    const userExists = await User.exists({ _id: session.userId })
    if (!userExists) {
      await Session.deleteOne({ _id: session._id })
      response.status(401).json({ error: UNAUTHORIZED_MESSAGE })
      return
    }
    request.auth = { sessionId: session._id.toString(), userId: session.userId.toString() }
    next()
  } catch (error: unknown) {
    next(error)
  }
}
