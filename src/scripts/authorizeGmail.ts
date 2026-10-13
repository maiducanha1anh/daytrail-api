import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library'

const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
const CALLBACK_PATH = '/oauth2/callback'
const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1_000
const execFileAsync = promisify(execFile)

class AuthorizationSetupError extends Error {
  override name = 'AuthorizationSetupError'
}

type Arguments = { clientPath: string; outputPath: string }

function parseArguments(values: string[]): Arguments {
  const result: Partial<Arguments> = {}
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]
    const value = values[index + 1]
    if (!value) throw new AuthorizationSetupError('Thiếu giá trị cho tham số công cụ.')
    if (name === '--client') result.clientPath = resolve(value)
    else if (name === '--output') result.outputPath = resolve(value)
    else throw new AuthorizationSetupError('Công cụ chỉ nhận --client và --output.')
  }
  if (!result.clientPath || !result.outputPath) throw new AuthorizationSetupError('Cần truyền --client và --output.')
  if (result.clientPath === result.outputPath) throw new AuthorizationSetupError('File đầu ra phải khác file OAuth client.')
  return result as Arguments
}

async function ensureOutputDoesNotExist(path: string) {
  try {
    await access(path)
    throw new AuthorizationSetupError('File token đích đã tồn tại; công cụ không ghi đè. Hãy sao lưu hoặc đổi tên file cũ trước.')
  } catch (error: unknown) {
    if (error instanceof AuthorizationSetupError) throw error
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw new AuthorizationSetupError('Không thể kiểm tra file token đích.')
  }
}

async function readDesktopClient(path: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new AuthorizationSetupError('Không thể đọc file OAuth client dưới dạng JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || !('installed' in parsed) || !parsed.installed || typeof parsed.installed !== 'object') {
    throw new AuthorizationSetupError('Credentials phải là OAuth client loại Desktop app.')
  }
  const installed = parsed.installed as Record<string, unknown>
  if (typeof installed.client_id !== 'string' || typeof installed.client_secret !== 'string') {
    throw new AuthorizationSetupError('OAuth client thiếu trường bắt buộc.')
  }
  return { clientId: installed.client_id, clientSecret: installed.client_secret }
}

function sameState(actual: string, expected: string) {
  const actualHash = createHash('sha256').update(actual).digest()
  const expectedHash = createHash('sha256').update(expected).digest()
  return timingSafeEqual(actualHash, expectedHash)
}

function closeServer(server: Server) {
  return new Promise<void>((resolveClose) => server.close(() => resolveClose()))
}

function waitForCallback(server: Server, state: string) {
  return new Promise<string>((resolveCode, rejectCode) => {
    let settled = false
    const finish = (error?: Error, code?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) rejectCode(error)
      else resolveCode(code as string)
    }
    const timer = setTimeout(() => finish(new AuthorizationSetupError('Hết thời gian chờ Google trả kết quả cấp quyền.')), AUTHORIZATION_TIMEOUT_MS)
    timer.unref()
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Not found')
        return
      }
      const returnedState = url.searchParams.get('state') ?? ''
      const code = url.searchParams.get('code')
      const oauthError = url.searchParams.get('error')
      if (!sameState(returnedState, state)) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end('<h1>DayTrail</h1><p>Yêu cầu cấp quyền không hợp lệ. Bạn có thể đóng cửa sổ này.</p>')
        finish(new AuthorizationSetupError('Google trả về state không hợp lệ.'))
        return
      }
      if (oauthError || !code) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end('<h1>DayTrail</h1><p>Quyền gửi email chưa được cấp. Bạn có thể đóng cửa sổ này.</p>')
        finish(new AuthorizationSetupError(oauthError === 'access_denied' ? 'Người dùng đã từ chối quyền.' : 'Google không trả authorization code.'))
        return
      }
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'Content-Type': 'text/html; charset=utf-8',
      })
      response.end('<h1>DayTrail</h1><p>Đã nhận quyền gửi email. Bạn có thể đóng cửa sổ này và quay lại PowerShell.</p>')
      finish(undefined, code)
    })
  })
}

async function openSystemBrowser(url: string) {
  if (process.platform !== 'win32') throw new AuthorizationSetupError('Công cụ hiện chỉ tự mở trình duyệt trên Windows.')
  try {
    await execFileAsync('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true })
  } catch {
    throw new AuthorizationSetupError('Không thể mở trình duyệt hệ thống.')
  }
}

async function protectFile(path: string) {
  await chmod(path, 0o600)
  if (process.platform !== 'win32') return
  try {
    const identity = (await execFileAsync('whoami.exe', [], { windowsHide: true })).stdout.trim()
    if (!identity) throw new Error('Missing Windows identity')
    await execFileAsync('icacls.exe', [path, '/inheritance:r', '/grant:r', `${identity}:F`], { windowsHide: true })
  } catch {
    await rm(path, { force: true })
    throw new AuthorizationSetupError('Không thể giới hạn quyền đọc file token cho tài khoản Windows hiện tại; file chưa được giữ lại.')
  }
}

async function saveAuthorizedUser(path: string, client: { clientId: string; clientSecret: string }, refreshToken: string) {
  await mkdir(dirname(path), { recursive: true })
  const body = JSON.stringify({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    created_at: new Date().toISOString(),
    refresh_token: refreshToken,
    scope: GMAIL_SEND_SCOPE,
    token_uri: 'https://oauth2.googleapis.com/token',
    type: 'authorized_user',
  }, null, 2)
  await writeFile(path, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  await protectFile(path)
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  await ensureOutputDoesNotExist(args.outputPath)
  const client = await readDesktopClient(args.clientPath)
  const state = randomBytes(32).toString('base64url')
  const server = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new AuthorizationSetupError('Không xác định được cổng callback loopback.')
    const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`
    const oauth = new OAuth2Client(client.clientId, client.clientSecret, redirectUri)
    const verifier = await oauth.generateCodeVerifierAsync()
    const authUrl = oauth.generateAuthUrl({
      access_type: 'offline',
      code_challenge: verifier.codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      prompt: 'consent',
      scope: [GMAIL_SEND_SCOPE],
      state,
    })
    const callback = waitForCallback(server, state)
    console.log('Đang mở trình duyệt để bạn tự chọn tài khoản Google và duyệt đúng quyền gửi email Gmail.')
    await openSystemBrowser(authUrl)
    const code = await callback
    let tokens
    try {
      tokens = (await oauth.getToken({ code, codeVerifier: verifier.codeVerifier, redirect_uri: redirectUri })).tokens
    } catch {
      throw new AuthorizationSetupError('Google từ chối đổi authorization code lấy token. Không có token nào được lưu.')
    }
    if (!tokens.refresh_token) throw new AuthorizationSetupError('Google không trả refresh token. Không ghi đè file cũ; hãy thu hồi quyền ứng dụng rồi cấp lại với consent.')
    if (tokens.scope && !tokens.scope.split(/\s+/).includes(GMAIL_SEND_SCOPE)) throw new AuthorizationSetupError('Token không có đúng quyền gmail.send. Không có token nào được lưu.')
    await saveAuthorizedUser(args.outputPath, client, tokens.refresh_token)
    console.log('Đã lưu file authorized-user ngoài repo và giới hạn quyền đọc cho tài khoản Windows hiện tại.')
  } finally {
    await closeServer(server)
  }
}

main().catch((error: unknown) => {
  const message = error instanceof AuthorizationSetupError ? error.message : `Cấp quyền Gmail thất bại (${error instanceof Error ? error.name : 'UnknownError'}).`
  console.error(message)
  process.exitCode = 1
})
