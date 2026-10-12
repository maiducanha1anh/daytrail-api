import { createHash, randomBytes } from 'node:crypto'
import mongoose, { type Types } from 'mongoose'
import { passwordChangedEmail, passwordResetEmail, verificationEmail } from '../email/templates.js'
import { safeEmailFailureCode, type EmailSender } from '../email/sender.js'
import { AccountToken, type AccountTokenPurpose } from '../models/AccountToken.js'
import { Session } from '../models/Session.js'
import { User } from '../models/User.js'
import { hashPassword, verifyPassword } from './password.js'

export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1_000
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1_000

export class AccountActionError extends Error {
  constructor(message: string, readonly code: 'CURRENT_PASSWORD_INVALID' | 'PASSWORD_CHANGED' | 'TOKEN_INVALID_OR_EXPIRED') {
    super(message)
    this.name = 'AccountActionError'
  }
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function accountUrl(frontendBaseUrl: string, route: 'reset-password' | 'verify-email', token: string) {
  const url = new URL(frontendBaseUrl)
  url.hash = `${route}?token=${encodeURIComponent(token)}`
  return url.toString()
}

async function deliverToken(input: {
  displayName: string
  email: string
  emailSender: EmailSender
  frontendBaseUrl: string
  purpose: AccountTokenPurpose
  ttlMs: number
  userId: Types.ObjectId
}) {
  const token = randomBytes(32).toString('base64url')
  const tokenRecord = await AccountToken.create({
    email: input.email,
    expiresAt: new Date(Date.now() + input.ttlMs),
    purpose: input.purpose,
    tokenHash: hashToken(token),
    userId: input.userId,
  })
  const url = accountUrl(input.frontendBaseUrl, input.purpose === 'password_reset' ? 'reset-password' : 'verify-email', token)
  const message = input.purpose === 'password_reset'
    ? passwordResetEmail(input.displayName, input.email, url)
    : verificationEmail(input.displayName, input.email, url)
  try {
    await input.emailSender.send(message)
    const databaseSession = await mongoose.startSession()
    try {
      await databaseSession.withTransaction(async () => {
        const delivered = await AccountToken.updateOne({ _id: tokenRecord._id }, { $set: { deliveredAt: new Date() } }, { session: databaseSession })
        if (delivered.modifiedCount !== 1) throw new Error('Account token disappeared before delivery confirmation')
        await AccountToken.deleteMany({
          _id: { $ne: tokenRecord._id },
          userId: input.userId,
          purpose: input.purpose,
          deliveredAt: { $exists: true },
        }, { session: databaseSession })
      })
    } finally {
      await databaseSession.endSession()
    }
    return true
  } catch (error: unknown) {
    await AccountToken.deleteOne({ _id: tokenRecord._id, deliveredAt: { $exists: false } }).catch(() => undefined)
    console.error(`Email delivery failed (${safeEmailFailureCode(error)})`)
    return false
  }
}

export function sendPasswordReset(input: Omit<Parameters<typeof deliverToken>[0], 'purpose' | 'ttlMs'>) {
  return deliverToken({ ...input, purpose: 'password_reset', ttlMs: PASSWORD_RESET_TTL_MS })
}

export function sendEmailVerification(input: Omit<Parameters<typeof deliverToken>[0], 'purpose' | 'ttlMs'>) {
  return deliverToken({ ...input, purpose: 'email_verification', ttlMs: EMAIL_VERIFICATION_TTL_MS })
}

async function notifyPasswordChanged(emailSender: EmailSender, displayName: string, email: string) {
  try {
    await emailSender.send(passwordChangedEmail(displayName, email))
    return true
  } catch (error: unknown) {
    console.error(`Password change notification failed (${safeEmailFailureCode(error)})`)
    return false
  }
}

export async function resetPassword(input: { emailSender: EmailSender; newPassword: string; token: string }) {
  const passwordHash = await hashPassword(input.newPassword)
  const databaseSession = await mongoose.startSession()
  let userIdentity: { displayName: string; email: string } | undefined
  try {
    await databaseSession.withTransaction(async () => {
      const tokenRecord = await AccountToken.findOne({
        tokenHash: hashToken(input.token),
        purpose: 'password_reset',
        deliveredAt: { $exists: true },
        expiresAt: { $gt: new Date() },
      }).session(databaseSession)
      if (!tokenRecord) throw new AccountActionError('Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.', 'TOKEN_INVALID_OR_EXPIRED')
      const user = await User.findOneAndUpdate(
        { _id: tokenRecord.userId, email: tokenRecord.email },
        { $set: { passwordHash }, $inc: { credentialVersion: 1 } },
        { returnDocument: 'after', session: databaseSession },
      )
      if (!user) throw new AccountActionError('Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.', 'TOKEN_INVALID_OR_EXPIRED')
      await Session.deleteMany({ userId: user._id }, { session: databaseSession })
      await AccountToken.deleteMany({ userId: user._id, purpose: 'password_reset' }, { session: databaseSession })
      userIdentity = { displayName: user.displayName, email: user.email }
    })
  } finally {
    await databaseSession.endSession()
  }
  if (!userIdentity) throw new AccountActionError('Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.', 'TOKEN_INVALID_OR_EXPIRED')
  const notificationEmailSent = await notifyPasswordChanged(input.emailSender, userIdentity.displayName, userIdentity.email)
  return { notificationEmailSent }
}

export async function changePassword(input: { currentPassword: string; emailSender: EmailSender; newPassword: string; userId: string }) {
  const currentUser = await User.findById(input.userId).select('+passwordHash credentialVersion displayName email')
  if (!currentUser || !(await verifyPassword(input.currentPassword, currentUser.passwordHash))) {
    throw new AccountActionError('Mật khẩu hiện tại không đúng.', 'CURRENT_PASSWORD_INVALID')
  }
  if (await verifyPassword(input.newPassword, currentUser.passwordHash)) {
    throw new AccountActionError('Mật khẩu mới phải khác mật khẩu hiện tại.', 'CURRENT_PASSWORD_INVALID')
  }
  const passwordHash = await hashPassword(input.newPassword)
  const databaseSession = await mongoose.startSession()
  try {
    await databaseSession.withTransaction(async () => {
      const updated = await User.updateOne(
        { _id: currentUser._id, passwordHash: currentUser.passwordHash },
        { $set: { passwordHash }, $inc: { credentialVersion: 1 } },
        { session: databaseSession },
      )
      if (updated.modifiedCount !== 1) throw new AccountActionError('Mật khẩu đã thay đổi ở một yêu cầu khác. Hãy đăng nhập lại.', 'PASSWORD_CHANGED')
      await Session.deleteMany({ userId: currentUser._id }, { session: databaseSession })
      await AccountToken.deleteMany({ userId: currentUser._id, purpose: 'password_reset' }, { session: databaseSession })
    })
  } finally {
    await databaseSession.endSession()
  }
  const notificationEmailSent = await notifyPasswordChanged(input.emailSender, currentUser.displayName, currentUser.email)
  return { notificationEmailSent }
}

export async function verifyEmail(token: string) {
  const databaseSession = await mongoose.startSession()
  try {
    await databaseSession.withTransaction(async () => {
      const tokenRecord = await AccountToken.findOne({
        tokenHash: hashToken(token),
        purpose: 'email_verification',
        deliveredAt: { $exists: true },
        expiresAt: { $gt: new Date() },
      }).session(databaseSession)
      if (!tokenRecord) throw new AccountActionError('Liên kết xác minh không hợp lệ hoặc đã hết hạn.', 'TOKEN_INVALID_OR_EXPIRED')
      const updated = await User.updateOne(
        { _id: tokenRecord.userId, email: tokenRecord.email },
        { $set: { emailVerifiedAt: new Date() } },
        { session: databaseSession },
      )
      if (updated.matchedCount !== 1) throw new AccountActionError('Liên kết xác minh không hợp lệ hoặc đã hết hạn.', 'TOKEN_INVALID_OR_EXPIRED')
      await AccountToken.deleteMany({ userId: tokenRecord.userId, purpose: 'email_verification' }, { session: databaseSession })
    })
  } finally {
    await databaseSession.endSession()
  }
}
