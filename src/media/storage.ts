import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { MediaStorageConfig } from '../config/env.js'

export type StoredMediaObject = {
  body: Buffer
  contentType: string
}

export interface MediaStorage {
  deleteObject(key: string): Promise<void>
  getObject(key: string): Promise<StoredMediaObject>
  listKeys(prefix: string): Promise<string[]>
  putObject(key: string, body: Buffer, contentType: string): Promise<void>
}

export class MediaStorageOperationError extends Error {
  override name = 'MediaStorageOperationError'
  constructor(readonly safeCode: string) {
    super('Media storage operation failed')
  }
}

function safeStorageCode(error: unknown) {
  if (!error || typeof error !== 'object') return 'UnknownError'
  const name = 'name' in error && typeof error.name === 'string' ? error.name : 'StorageError'
  const metadata = '$metadata' in error && error.$metadata && typeof error.$metadata === 'object' ? error.$metadata : undefined
  const status = metadata && 'httpStatusCode' in metadata && typeof metadata.httpStatusCode === 'number'
    ? metadata.httpStatusCode
    : undefined
  return status ? `${name}:${status}` : name
}

function withAbortTimeout<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref()
  return operation(controller.signal).finally(() => clearTimeout(timer))
}

export function createR2MediaStorage(config: MediaStorageConfig): MediaStorage {
  const client = new S3Client({
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    endpoint: config.endpoint,
    forcePathStyle: true,
    region: 'auto',
  })

  async function send<T>(operation: (signal: AbortSignal) => Promise<T>) {
    try {
      return await withAbortTimeout(config.timeoutMs, operation)
    } catch (error: unknown) {
      throw new MediaStorageOperationError(safeStorageCode(error))
    }
  }

  return {
    async deleteObject(key) {
      await send((abortSignal) => client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }), { abortSignal }))
    },
    async getObject(key) {
      const result = await send((abortSignal) => client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), { abortSignal }))
      if (!result.Body) throw new MediaStorageOperationError('EmptyBody')
      const body = Buffer.from(await result.Body.transformToByteArray())
      return { body, contentType: result.ContentType || 'application/octet-stream' }
    },
    async listKeys(prefix) {
      const keys: string[] = []
      let continuationToken: string | undefined
      do {
        const result = await send((abortSignal) => client.send(new ListObjectsV2Command({
          Bucket: config.bucket,
          ContinuationToken: continuationToken,
          Prefix: prefix,
        }), { abortSignal }))
        for (const item of result.Contents ?? []) if (item.Key) keys.push(item.Key)
        continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined
      } while (continuationToken)
      return keys
    },
    async putObject(key, body, contentType) {
      await send((abortSignal) => client.send(new PutObjectCommand({
        Body: body,
        Bucket: config.bucket,
        CacheControl: 'private, no-store',
        ContentType: contentType,
        Key: key,
      }), { abortSignal }))
    },
  }
}
