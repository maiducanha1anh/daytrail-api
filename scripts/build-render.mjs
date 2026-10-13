import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, cp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import frontendLock from '../render.frontend-lock.mjs'

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workDirectory = join(rootDirectory, '.render-build')
const frontendSourceDirectory = join(workDirectory, 'frontend-source')
const frontendOutputDirectory = join(rootDirectory, 'render-frontend-dist')
const npmInvocation = process.env.npm_execpath
  ? { command: process.execPath, prefix: [process.env.npm_execpath] }
  : { command: 'npm', prefix: [] }

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? rootDirectory,
      env: options.env ?? process.env,
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', rejectPromise)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}

function capture(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = ''
    const child = spawn(command, args, {
      cwd: options.cwd ?? rootDirectory,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.once('error', rejectPromise)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise(stdout.trim())
      else rejectPromise(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}

async function validateBuildDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) throw new Error('Frontend build contains a hidden file')
    if (entry.isSymbolicLink()) throw new Error('Frontend build contains a symbolic link')
    if (entry.isDirectory()) await validateBuildDirectory(join(directory, entry.name))
  }
}

async function main() {
  const lock = frontendLock
  if (typeof lock.repository !== 'string' || typeof lock.commit !== 'string' || !/^[a-f0-9]{40}$/.test(lock.commit)) {
    throw new Error('render.frontend-lock.mjs is invalid')
  }
  const repositoryUrl = new URL(lock.repository)
  if (repositoryUrl.protocol !== 'https:' || repositoryUrl.hostname !== 'github.com' || repositoryUrl.username || repositoryUrl.password) {
    throw new Error('Frontend repository must be a credential-free GitHub HTTPS URL')
  }

  await rm(workDirectory, { force: true, recursive: true })
  await rm(frontendOutputDirectory, { force: true, recursive: true })
  await mkdir(frontendSourceDirectory, { recursive: true })

  try {
    await run('git', ['init', frontendSourceDirectory])
    await run('git', ['-C', frontendSourceDirectory, 'remote', 'add', 'origin', lock.repository])
    await run('git', ['-C', frontendSourceDirectory, 'fetch', '--depth=1', 'origin', lock.commit])
    await run('git', ['-C', frontendSourceDirectory, 'checkout', '--detach', 'FETCH_HEAD'])
    const checkedOutCommit = await capture('git', ['-C', frontendSourceDirectory, 'rev-parse', 'HEAD'])
    if (checkedOutCommit !== lock.commit) throw new Error('Fetched frontend commit does not match the lock file')

    await run(npmInvocation.command, [...npmInvocation.prefix, 'ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: frontendSourceDirectory })
    await run(npmInvocation.command, [...npmInvocation.prefix, 'run', 'build'], {
      cwd: frontendSourceDirectory,
      env: { ...process.env, VITE_API_BASE_URL: '' },
    })

    const sourceOutput = join(frontendSourceDirectory, 'dist')
    await access(join(sourceOutput, 'index.html'), constants.R_OK)
    await validateBuildDirectory(sourceOutput)
    await cp(sourceOutput, frontendOutputDirectory, { recursive: true })
    const builtFiles = await readdir(frontendOutputDirectory, { recursive: true })
    for (const file of builtFiles) {
      if (typeof file !== 'string' || !file.endsWith('.js')) continue
      const content = await readFile(join(frontendOutputDirectory, file), 'utf8')
      if (content.includes('http://localhost:4000')) {
        throw new Error('Frontend artifact still contains the development API URL')
      }
    }
    console.log(`Frontend ${lock.commit} built for same-origin API access`)
  } catch (error) {
    await rm(frontendOutputDirectory, { force: true, recursive: true })
    throw error
  } finally {
    await rm(workDirectory, { force: true, recursive: true })
  }
}

main().catch((error) => {
  console.error(`Render frontend build failed (${error instanceof Error ? error.message : 'UnknownError'})`)
  process.exitCode = 1
})
