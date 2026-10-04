import { Types } from 'mongoose'
import { Journal, type JournalDocument } from '../models/Journal.js'
import { JOURNAL_EXCERPT_MAX_LENGTH, type JournalListInput, type SaveJournalInput } from './validation.js'

export class JournalNotFoundError extends Error {
  override name = 'JournalNotFoundError'
}

export class JournalConflictError extends Error {
  override name = 'JournalConflictError'
}

function ownerId(userId: string) {
  return new Types.ObjectId(userId)
}

function isDuplicateKeyError(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000)
}

function publicJournal(journal: JournalDocument) {
  return {
    content: journal.content,
    createdAt: journal.createdAt.toISOString(),
    date: journal.date,
    updatedAt: journal.updatedAt.toISOString(),
    version: journal.version,
  }
}

function excerpt(content: string) {
  return content.replace(/\s+/gu, ' ').trim().slice(0, JOURNAL_EXCERPT_MAX_LENGTH)
}

export async function getJournal(userId: string, date: string) {
  const journal = await Journal.findOne({ userId: ownerId(userId), date })
  return journal ? publicJournal(journal) : null
}

export async function saveJournal(userId: string, date: string, input: SaveJournalInput) {
  const userIdValue = ownerId(userId)
  if (input.version === null) {
    try {
      const journal = await Journal.create({ content: input.content, date, userId: userIdValue })
      return { created: true, journal: publicJournal(journal) }
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) throw new JournalConflictError('Nhật ký ngày này đã được tạo. Hãy tải lại dữ liệu mới nhất.')
      throw error
    }
  }

  const journal = await Journal.findOneAndUpdate(
    { userId: userIdValue, date, version: input.version },
    { $inc: { version: 1 }, $set: { content: input.content } },
    { returnDocument: 'after', runValidators: true },
  )
  if (journal) return { created: false, journal: publicJournal(journal) }
  if (await Journal.exists({ userId: userIdValue, date })) {
    throw new JournalConflictError('Nhật ký đã thay đổi ở nơi khác. Hãy tải lại trước khi lưu.')
  }
  throw new JournalNotFoundError('Không tìm thấy nhật ký.')
}

export async function deleteJournal(userId: string, date: string, version: number) {
  const userIdValue = ownerId(userId)
  const journal = await Journal.findOneAndDelete({ userId: userIdValue, date, version })
  if (journal) return
  if (await Journal.exists({ userId: userIdValue, date })) {
    throw new JournalConflictError('Nhật ký đã thay đổi ở nơi khác. Hãy tải lại trước khi xóa.')
  }
  throw new JournalNotFoundError('Không tìm thấy nhật ký.')
}

export async function listJournals(userId: string, input: JournalListInput) {
  const filter = { userId: ownerId(userId), date: { $gte: input.from, $lte: input.to } }
  const [journals, total] = await Promise.all([
    Journal.find(filter).sort({ date: -1, _id: -1 }).skip((input.page - 1) * input.limit).limit(input.limit),
    Journal.countDocuments(filter),
  ])
  return {
    journals: journals.map((journal) => ({
      createdAt: journal.createdAt.toISOString(),
      date: journal.date,
      excerpt: excerpt(journal.content),
      updatedAt: journal.updatedAt.toISOString(),
      version: journal.version,
    })),
    pagination: {
      limit: input.limit,
      page: input.page,
      pages: total === 0 ? 0 : Math.ceil(total / input.limit),
      total,
    },
  }
}
