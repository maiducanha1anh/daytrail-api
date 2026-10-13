import nodemailer from 'nodemailer'
import { OAuth2Client } from 'google-auth-library'
import { EmailDeliveryError, type EmailFailureCode, type EmailMessage, type EmailSender } from './sender.js'

const GMAIL_SEND_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'

export type GmailApiConfig = {
  clientId: string
  clientSecret: string
  refreshToken: string
  senderEmail: string
  timeoutMs: number
}

type GmailApiDependencies = {
  accessToken?: () => Promise<string>
  fetch?: typeof globalThis.fetch
}

function statusCode(error: unknown) {
  if (!error || typeof error !== 'object') return undefined
  if ('status' in error && typeof error.status === 'number') return error.status
  if ('response' in error && error.response && typeof error.response === 'object' && 'status' in error.response && typeof error.response.status === 'number') return error.response.status
  return undefined
}

function oauthErrorCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('response' in error) || !error.response || typeof error.response !== 'object' || !('data' in error.response)) return undefined
  const data = error.response.data
  if (!data || typeof data !== 'object' || !('error' in data) || typeof data.error !== 'string') return undefined
  return data.error
}

function classifyFailure(error: unknown): EmailFailureCode {
  if (error instanceof EmailDeliveryError) return error.code
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return 'GMAIL_TIMEOUT'
  if (oauthErrorCode(error) === 'invalid_grant') return 'GMAIL_INVALID_GRANT'
  const status = statusCode(error)
  if (status === 401) return 'GMAIL_AUTH'
  if (status === 403) return 'GMAIL_PERMISSION_DENIED'
  if (status === 429) return 'GMAIL_QUOTA'
  if (status && status >= 500) return 'GMAIL_SERVER'
  if (error instanceof TypeError) return 'GMAIL_NETWORK'
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^(ECONN|ENET|EAI_|ETIMEDOUT)/.test(error.code)) return 'GMAIL_NETWORK'
  return 'GMAIL_UNKNOWN'
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new EmailDeliveryError('GMAIL_TIMEOUT')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function createGmailRawMessage(senderEmail: string, message: EmailMessage) {
  const transport = nodemailer.createTransport({ buffer: true, newline: 'windows', streamTransport: true })
  const result = await transport.sendMail({
    from: { address: senderEmail, name: 'DayTrail' },
    html: message.html,
    subject: message.subject,
    text: message.text,
    to: message.to,
  })
  if (!Buffer.isBuffer(result.message)) throw new EmailDeliveryError('GMAIL_UNKNOWN')
  return result.message.toString('base64url')
}

function defaultAccessToken(config: GmailApiConfig) {
  const oauth = new OAuth2Client(config.clientId, config.clientSecret)
  oauth.setCredentials({ refresh_token: config.refreshToken })
  return async () => {
    try {
      const result = await withTimeout(oauth.getAccessToken(), config.timeoutMs)
      if (!result.token) throw new EmailDeliveryError('GMAIL_AUTH')
      return result.token
    } catch (error: unknown) {
      throw new EmailDeliveryError(classifyFailure(error))
    }
  }
}

async function gmailFailure(response: Response): Promise<EmailDeliveryError> {
  if (response.status === 401) return new EmailDeliveryError('GMAIL_AUTH')
  if (response.status === 429) return new EmailDeliveryError('GMAIL_QUOTA')
  if (response.status >= 500) return new EmailDeliveryError('GMAIL_SERVER')
  if (response.status === 403) {
    try {
      const data = await response.json() as { error?: { errors?: Array<{ reason?: string }> } }
      const reasons = data.error?.errors?.map((entry) => entry.reason) ?? []
      if (reasons.some((reason) => reason && /(?:RateLimit|quota|dailyLimit)/i.test(reason))) return new EmailDeliveryError('GMAIL_QUOTA')
    } catch {
      // The status alone remains enough for a safe classification.
    }
    return new EmailDeliveryError('GMAIL_PERMISSION_DENIED')
  }
  return new EmailDeliveryError('GMAIL_UNKNOWN')
}

export function createGmailApiEmailSender(config: GmailApiConfig, dependencies: GmailApiDependencies = {}): EmailSender {
  const accessToken = dependencies.accessToken ?? defaultAccessToken(config)
  const request = dependencies.fetch ?? globalThis.fetch
  return {
    async send(message) {
      const raw = await createGmailRawMessage(config.senderEmail, message)
      let token: string
      try {
        token = await withTimeout(accessToken(), config.timeoutMs)
      } catch (error: unknown) {
        throw new EmailDeliveryError(classifyFailure(error))
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), config.timeoutMs)
      try {
        const response = await request(GMAIL_SEND_ENDPOINT, {
          body: JSON.stringify({ raw }),
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
          signal: controller.signal,
        })
        if (!response.ok) throw await gmailFailure(response)
      } catch (error: unknown) {
        throw new EmailDeliveryError(classifyFailure(error))
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
