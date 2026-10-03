import { createHash, randomBytes } from 'node:crypto'
import type { CookieOptions } from 'express'
import type { Types } from 'mongoose'
import { Session } from '../models/Session.js'

export const SESSION_COOKIE_NAME = 'daytrail_session'

export function createSessionToken() {
  return randomBytes(32).toString('base64url')
}

export function hashSessionToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function sessionCookieOptions(secure: boolean, maxAge: number): CookieOptions {
  return {
    httpOnly: true,
    maxAge,
    path: '/',
    sameSite: 'lax',
    secure,
  }
}

export function clearSessionCookieOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    secure,
  }
}

export async function createSession(userId: Types.ObjectId, ttlMs: number) {
  const token = createSessionToken()
  const expiresAt = new Date(Date.now() + ttlMs)
  const session = await Session.create({
    expiresAt,
    tokenHash: hashSessionToken(token),
    userId,
  })
  return { expiresAt, session, token }
}
