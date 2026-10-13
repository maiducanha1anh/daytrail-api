import nodemailer from 'nodemailer'

export type EmailMessage = {
  html: string
  subject: string
  text: string
  to: string
}

export type EmailSender = {
  send(message: EmailMessage): Promise<void>
}

export type EmailFailureCode =
  | 'GMAIL_AUTH'
  | 'GMAIL_INVALID_GRANT'
  | 'GMAIL_NETWORK'
  | 'GMAIL_PERMISSION_DENIED'
  | 'GMAIL_QUOTA'
  | 'GMAIL_SERVER'
  | 'GMAIL_TIMEOUT'
  | 'GMAIL_UNKNOWN'

export type SmtpConfig = {
  from: string
  host: string
  password?: string
  port: number
  requireTls: boolean
  secure: boolean
  timeoutMs: number
  user?: string
}

export class EmailUnavailableError extends Error {
  override name = 'EmailUnavailableError'
}

export class EmailDeliveryError extends Error {
  override name = 'EmailDeliveryError'

  constructor(readonly code: EmailFailureCode) {
    super('Email delivery provider rejected or could not confirm the request')
  }
}

export function createUnavailableEmailSender(): EmailSender {
  return {
    async send() {
      throw new EmailUnavailableError('Email service is not configured')
    },
  }
}

export function createSmtpEmailSender(config: SmtpConfig): EmailSender {
  const transporter = nodemailer.createTransport({
    auth: config.user && config.password ? { user: config.user, pass: config.password } : undefined,
    connectionTimeout: config.timeoutMs,
    greetingTimeout: config.timeoutMs,
    host: config.host,
    port: config.port,
    requireTLS: config.requireTls,
    secure: config.secure,
    socketTimeout: config.timeoutMs,
  })
  return {
    async send(message) {
      await transporter.sendMail({ ...message, from: config.from })
    },
  }
}

export function safeEmailFailureCode(error: unknown) {
  if (error instanceof EmailUnavailableError) return 'NOT_CONFIGURED'
  if (error instanceof EmailDeliveryError) return error.code
  if (!error || typeof error !== 'object') return 'UNKNOWN'
  if ('code' in error && typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code)) return error.code
  return error instanceof Error ? error.name : 'UNKNOWN'
}
