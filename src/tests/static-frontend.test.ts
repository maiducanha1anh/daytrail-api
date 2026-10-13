import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import request from 'supertest'
import { createApp } from '../app.js'

let frontendDirectory = ''

before(async () => {
  frontendDirectory = await mkdtemp(join(tmpdir(), 'daytrail-frontend-'))
  await mkdir(join(frontendDirectory, 'assets'))
  await writeFile(join(frontendDirectory, 'index.html'), '<!doctype html><title>DayTrail production artifact</title>')
  await writeFile(join(frontendDirectory, 'assets', 'app.js'), 'window.dayTrailLoaded = true')
  await writeFile(join(frontendDirectory, '.env'), 'SHOULD_NOT_BE_SERVED=true')
})

after(async () => {
  await rm(frontendDirectory, { force: true, recursive: true })
})

function app() {
  return createApp({
    authRateLimitMax: 10,
    authRateLimitWindowMs: 60_000,
    cookieSecure: true,
    frontendDistDir: frontendDirectory,
    frontendOrigin: 'https://daytrail-preview.onrender.com',
    isDatabaseReady: async () => true,
    sessionTtlMs: 7 * 24 * 60 * 60 * 1_000,
    trustProxy: 1,
  })
}

describe('production frontend serving', () => {
  it('serves only the built frontend root and assets', async () => {
    const root = await request(app()).get('/').expect(200).expect('Content-Type', /html/)
    assert.match(root.text, /DayTrail production artifact/)
    await request(app()).get('/assets/app.js').expect(200).expect('Content-Type', /javascript/)
  })

  it('returns JSON 404 for an unknown API instead of index.html', async () => {
    const response = await request(app()).get('/api/does-not-exist').expect(404).expect('Content-Type', /json/)
    assert.equal(response.body.code, 'API_NOT_FOUND')
    assert.doesNotMatch(response.text, /DayTrail production artifact/)
  })

  it('does not expose dotfiles, source-like paths, or arbitrary routes', async () => {
    const dotfile = await request(app()).get('/.env').expect(404)
    assert.doesNotMatch(dotfile.text, /SHOULD_NOT_BE_SERVED/)
    await request(app()).get('/src/app.ts').expect(404)
    await request(app()).get('/calendar').expect(404)
  })

  it('does not return index.html for an unknown non-GET request', async () => {
    const response = await request(app()).post('/missing').expect(404)
    assert.doesNotMatch(response.text, /DayTrail production artifact/)
  })
})
