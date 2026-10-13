import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { ConfigurationError, loadConfig, loadTestConfig } from '../config/env.js'

const managedNames = [
  'EMAIL_PROVIDER',
  'FRONTEND_BASE_URL',
  'FRONTEND_ORIGIN',
  'MONGODB_DATABASE',
  'MONGODB_TEST_URI',
  'MONGODB_URI',
  'NODE_ENV',
] as const

const originalEnvironment = new Map(managedNames.map((name) => [name, process.env[name]]))

function restoreEnvironment() {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

function configureApplication(uri: string, databaseName?: string) {
  process.env.NODE_ENV = 'development'
  process.env.EMAIL_PROVIDER = 'disabled'
  process.env.FRONTEND_ORIGIN = 'http://localhost:5173'
  process.env.FRONTEND_BASE_URL = 'http://localhost:5173'
  process.env.MONGODB_URI = uri
  if (databaseName === undefined) delete process.env.MONGODB_DATABASE
  else process.env.MONGODB_DATABASE = databaseName
}

afterEach(restoreEnvironment)

describe('MongoDB environment configuration', () => {
  it('keeps daytrail as the default application database', () => {
    configureApplication('mongodb://localhost/daytrail')
    const config = loadConfig()
    assert.equal(config.databaseName, 'daytrail')
  })

  it('accepts daytrail_preview when the URI matches exactly', () => {
    configureApplication('mongodb://localhost/daytrail_preview', 'daytrail_preview')
    const config = loadConfig()
    assert.equal(config.databaseName, 'daytrail_preview')
  })

  it('rejects an application URI without a database name', () => {
    configureApplication('mongodb://localhost/', 'daytrail_preview')
    assert.throws(() => loadConfig(), ConfigurationError)
  })

  it('rejects an application URI targeting a different database', () => {
    configureApplication('mongodb://localhost/daytrail', 'daytrail_preview')
    assert.throws(() => loadConfig(), ConfigurationError)
  })

  it('does not allow the application configuration to select daytrail_test', () => {
    configureApplication('mongodb://localhost/daytrail_test', 'daytrail_test')
    assert.throws(() => loadConfig(), ConfigurationError)
  })

  it('keeps test configuration fixed to daytrail_test', () => {
    process.env.MONGODB_DATABASE = 'daytrail_preview'
    process.env.MONGODB_TEST_URI = 'mongodb://localhost/daytrail_test'
    const config = loadTestConfig()
    assert.equal(config.databaseName, 'daytrail_test')
    process.env.MONGODB_TEST_URI = 'mongodb://localhost/daytrail_preview'
    assert.throws(() => loadTestConfig(), ConfigurationError)
  })
})
