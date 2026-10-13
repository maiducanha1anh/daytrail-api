import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { loadEmailProviderConfig } from '../config/env.js'
import { createGmailApiEmailSender, createGmailRawMessage, type GmailApiConfig } from '../email/gmailApi.js'
import { EmailDeliveryError, safeEmailFailureCode, type EmailMessage } from '../email/sender.js'
import { passwordResetEmail, verificationEmail } from '../email/templates.js'

const gmailConfig: GmailApiConfig = {
  clientId: 'synthetic-client-id',
  clientSecret: 'synthetic-client-secret',
  refreshToken: 'synthetic-refresh-token',
  senderEmail: 'sender@example.test',
  timeoutMs: 100,
}

const message: EmailMessage = {
  html: '<p>Chào bạn, nội dung tiếng Việt.</p>',
  subject: 'Xác minh email DayTrail',
  text: 'Chào bạn, nội dung tiếng Việt.',
  to: 'recipient@example.test',
}

function decodeQuotedPrintable(value: string) {
  const unfolded = value.replace(/=\r?\n/g, '')
  const bytes: number[] = []
  for (let index = 0; index < unfolded.length; index += 1) {
    const encodedByte = unfolded.slice(index, index + 3)
    if (/^=[0-9A-F]{2}$/i.test(encodedByte)) {
      bytes.push(Number.parseInt(encodedByte.slice(1), 16))
      index += 2
    } else {
      bytes.push(unfolded.charCodeAt(index))
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

function decodeEncodedWords(value: string) {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?([BQ])\?([^?]+)\?=/gi, (_match, encoding: string, encoded: string) => {
      if (encoding.toUpperCase() === 'B') return Buffer.from(encoded, 'base64').toString('utf8')
      return decodeQuotedPrintable(encoded.replaceAll('_', ' '))
    })
}

function decodeGmailMime(raw: string) {
  const mime = Buffer.from(raw, 'base64url').toString('utf8')
  const [rawHeaders] = mime.split(/\r?\n\r?\n/, 1)
  const headers = rawHeaders.replace(/\r?\n[ \t]+/g, ' ')
  const subject = headers.match(/^Subject:\s*(.+)$/mi)?.[1]
  const boundary = headers.match(/boundary=\x22([^\x22]+)\x22/i)?.[1]
  assert.ok(subject)
  assert.ok(boundary)
  const decoded: { html?: string; text?: string } = {}
  for (const rawPart of mime.split(`--${boundary}`).slice(1, -1)) {
    const part = rawPart.replace(/^\r?\n/, '').replace(/\r?\n$/, '')
    const separator = part.search(/\r?\n\r?\n/)
    assert.notEqual(separator, -1)
    const partHeaders = part.slice(0, separator)
    const body = part.slice(separator).replace(/^\r?\n\r?\n/, '').replace(/\r?\n$/, '')
    assert.match(partHeaders, /Content-Transfer-Encoding:\s*quoted-printable/i)
    const content = decodeQuotedPrintable(body).replace(/\r\n/g, '\n')
    if (/Content-Type:\s*text\/plain/i.test(partHeaders)) decoded.text = content
    if (/Content-Type:\s*text\/html/i.test(partHeaders)) decoded.html = content
  }
  return { ...decoded, subject: decodeEncodedWords(subject) }
}

describe('email provider configuration', () => {
  test('requires an explicit provider and never falls back between providers', () => {
    assert.deepEqual(loadEmailProviderConfig('development', {}), { provider: 'disabled' })
    const smtp = loadEmailProviderConfig('test', {
      EMAIL_PROVIDER: 'smtp',
      SMTP_FROM: 'sender@example.test',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1025',
      SMTP_REQUIRE_TLS: 'false',
      SMTP_SECURE: 'false',
    })
    assert.equal(smtp.provider, 'smtp')
    assert.throws(() => loadEmailProviderConfig('production', {
      EMAIL_PROVIDER: 'gmail_api',
      GMAIL_SENDER_EMAIL: 'sender@example.test',
      SMTP_FROM: 'sender@example.test',
      SMTP_HOST: 'smtp.example.test',
      SMTP_PORT: '587',
    }), /Gmail OAuth credentials are incomplete/)
  })

  test('loads Gmail credentials from direct secrets or an authorized-user secret file', async () => {
    const direct = loadEmailProviderConfig('production', {
      EMAIL_PROVIDER: 'gmail_api',
      GMAIL_API_TIMEOUT_MS: '9000',
      GMAIL_OAUTH_CLIENT_ID: gmailConfig.clientId,
      GMAIL_OAUTH_CLIENT_SECRET: gmailConfig.clientSecret,
      GMAIL_OAUTH_REFRESH_TOKEN: gmailConfig.refreshToken,
      GMAIL_SENDER_EMAIL: gmailConfig.senderEmail,
    })
    assert.equal(direct.provider, 'gmail_api')
    if (direct.provider === 'gmail_api') assert.equal(direct.gmail.timeoutMs, 9000)

    const directory = await mkdtemp(join(tmpdir(), 'daytrail-gmail-config-'))
    const path = join(directory, 'authorized-user.json')
    try {
      await writeFile(path, JSON.stringify({
        client_id: gmailConfig.clientId,
        client_secret: gmailConfig.clientSecret,
        refresh_token: gmailConfig.refreshToken,
        scope: 'https://www.googleapis.com/auth/gmail.send',
        type: 'authorized_user',
      }))
      const fromFile = loadEmailProviderConfig('production', {
        EMAIL_PROVIDER: 'gmail_api',
        GMAIL_AUTHORIZED_USER_FILE: path,
        GMAIL_SENDER_EMAIL: gmailConfig.senderEmail,
      })
      assert.equal(fromFile.provider, 'gmail_api')
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})

describe('Gmail API email sender', () => {
  test('builds an RFC 2822 MIME message with fixed sender, HTML, plain text, and UTF-8', async () => {
    const raw = await createGmailRawMessage(gmailConfig.senderEmail, message)
    assert.match(raw, /^[A-Za-z0-9_-]+$/)
    const mime = Buffer.from(raw, 'base64url').toString('utf8')
    assert.match(mime, /From: DayTrail <sender@example\.test>/)
    assert.match(mime, /To: recipient@example\.test/)
    assert.match(mime, /Subject: =\?UTF-8\?/i)
    assert.match(mime, /Content-Type: multipart\/alternative/i)
    assert.match(mime, /Content-Type: text\/plain; charset=utf-8/i)
    assert.match(mime, /Content-Type: text\/html; charset=utf-8/i)
  })

  test('round-trips Vietnamese verification and password reset templates exactly through MIME', async () => {
    const templates = [
      verificationEmail('Người dùng thử', 'recipient@example.test', 'http://127.0.0.1:5185/verify-email?token=synthetic'),
      passwordResetEmail('Người dùng thử', 'recipient@example.test', 'http://127.0.0.1:5185/reset-password?token=synthetic'),
    ]
    for (const template of templates) {
      const raw = await createGmailRawMessage(gmailConfig.senderEmail, template)
      assert.deepEqual(decodeGmailMime(raw), {
        html: template.html,
        subject: template.subject,
        text: template.text,
      })
    }
    assert.match(templates[0].html, />Xác minh email<\/a>/)
    assert.match(templates[0].text, /có hiệu lực trong 24 giờ/)
    assert.match(templates[1].html, />Đặt lại mật khẩu<\/a>/)
    assert.match(templates[1].text, /có hiệu lực trong 30 phút/)
    for (const template of templates) assert.match(template.text, /Nếu bạn không thực hiện yêu cầu này, hãy bỏ qua email\.$/)
  })

  test('refreshes access and sends exactly one HTTPS request without retry', async () => {
    let tokenCalls = 0
    let fetchCalls = 0
    const sender = createGmailApiEmailSender(gmailConfig, {
      accessToken: async () => {
        tokenCalls += 1
        return 'synthetic-access-token'
      },
      fetch: async (input, init) => {
        fetchCalls += 1
        assert.equal(String(input), 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
        assert.equal(init?.method, 'POST')
        assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer synthetic-access-token')
        const body = JSON.parse(String(init?.body)) as { raw?: string }
        assert.match(body.raw ?? '', /^[A-Za-z0-9_-]+$/)
        return new Response(JSON.stringify({ id: 'accepted-by-google' }), { status: 200 })
      },
    })
    await sender.send(message)
    assert.equal(tokenCalls, 1)
    assert.equal(fetchCalls, 1)
  })

  test('classifies invalid_grant without exposing OAuth response details', async () => {
    const secret = 'secret-value-that-must-not-escape'
    const sender = createGmailApiEmailSender(gmailConfig, {
      accessToken: async () => Promise.reject({ response: { data: { error: 'invalid_grant', error_description: secret }, status: 400 } }),
    })
    await assert.rejects(sender.send(message), (error: unknown) => {
      assert.ok(error instanceof EmailDeliveryError)
      assert.equal(safeEmailFailureCode(error), 'GMAIL_INVALID_GRANT')
      assert.doesNotMatch(error.message, new RegExp(secret))
      return true
    })
  })

  test('classifies quota, permission, server, and network failures safely without retries', async () => {
    const cases: Array<{ expected: string; response?: Response; thrown?: Error }> = [
      { expected: 'GMAIL_QUOTA', response: new Response('{}', { status: 429 }) },
      { expected: 'GMAIL_PERMISSION_DENIED', response: new Response(JSON.stringify({ error: { errors: [{ reason: 'insufficientPermissions' }] } }), { status: 403 }) },
      { expected: 'GMAIL_SERVER', response: new Response('{}', { status: 503 }) },
      { expected: 'GMAIL_NETWORK', thrown: new TypeError('network failure with synthetic secret') },
    ]
    for (const scenario of cases) {
      let calls = 0
      const sender = createGmailApiEmailSender(gmailConfig, {
        accessToken: async () => 'synthetic-access-token',
        fetch: async () => {
          calls += 1
          if (scenario.thrown) throw scenario.thrown
          return scenario.response as Response
        },
      })
      await assert.rejects(sender.send(message), (error: unknown) => {
        assert.ok(error instanceof EmailDeliveryError)
        assert.equal(safeEmailFailureCode(error), scenario.expected)
        assert.doesNotMatch(error.message, /synthetic secret/i)
        return true
      })
      assert.equal(calls, 1)
    }
  })

  test('times out token refresh without sending a Gmail request', async () => {
    let fetchCalls = 0
    const sender = createGmailApiEmailSender({ ...gmailConfig, timeoutMs: 10 }, {
      accessToken: () => new Promise<string>(() => undefined),
      fetch: async () => {
        fetchCalls += 1
        return new Response('{}', { status: 200 })
      },
    })
    await assert.rejects(sender.send(message), (error: unknown) => {
      assert.equal(safeEmailFailureCode(error), 'GMAIL_TIMEOUT')
      return true
    })
    assert.equal(fetchCalls, 0)
  })
})
