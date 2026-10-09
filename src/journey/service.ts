import { Types } from 'mongoose'
import { Journal } from '../models/Journal.js'
import { JourneyAlbum, type JourneyAlbumDocument } from '../models/JourneyAlbum.js'
import { JourneyHighlight, type JourneyHighlightDocument } from '../models/JourneyHighlight.js'
import { JourneyPhase, type JourneyPhaseDocument } from '../models/JourneyPhase.js'
import { MediaAsset, type MediaAssetDocument } from '../models/MediaAsset.js'
import { publicMedia } from '../media/service.js'
import {
  JourneyInputError,
  type JourneyAlbumInput,
  type JourneyHighlightInput,
  type JourneyPhaseInput,
  type JourneyPhaseUpdateInput,
  type JourneyTimelineInput,
} from './validation.js'

const EXCERPT_LENGTH = 220
const PREVIEW_DAY_LIMIT = 6
const THUMBNAIL_LIMIT = 3

type JournalSummary = {
  _id: Types.ObjectId
  contentLength: number
  contentPrefix: string
  createdAt: Date
  date: string
  updatedAt: Date
  version: number
}

type MediaDaySummary = {
  count: number
  date: string
  first: MediaAssetDocument
}

export class JourneyNotFoundError extends Error {
  override name = 'JourneyNotFoundError'
}

function ownerId(userId: string) {
  return new Types.ObjectId(userId)
}

function monthBounds(year: number, month: number) {
  const value = String(month).padStart(2, '0')
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { from: `${year}-${value}-01`, to: `${year}-${value}-${String(lastDay).padStart(2, '0')}` }
}

function excerpt(content: string, contentLength = Array.from(content).length) {
  const value = content.trim()
  if (!value) return null
  const characters = Array.from(value)
  const shortened = characters.slice(0, EXCERPT_LENGTH).join('')
  return contentLength > EXCERPT_LENGTH || characters.length > EXCERPT_LENGTH ? `${shortened}…` : shortened
}

function publicHighlight(highlight: JourneyHighlightDocument) {
  return {
    createdAt: highlight.createdAt.toISOString(),
    id: highlight._id.toString(),
    sourceId: highlight.sourceId.toString(),
    sourceType: 'journal' as const,
  }
}

function imageResponse(media: MediaAssetDocument) {
  return publicMedia(media)
}

async function loadJournalSummaries(userId: Types.ObjectId, from: string, to: string) {
  return Journal.aggregate<JournalSummary>([
    { $match: { userId, date: { $gte: from, $lte: to } } },
    { $sort: { date: 1, _id: 1 } },
    { $project: {
      contentLength: { $strLenCP: '$content' },
      contentPrefix: { $substrCP: ['$content', 0, EXCERPT_LENGTH + 1] },
      createdAt: 1,
      date: 1,
      updatedAt: 1,
      version: 1,
    } },
  ])
}

async function loadHighlights(userId: Types.ObjectId, journals: JournalSummary[]) {
  const values = journals.length === 0 ? [] : await JourneyHighlight.find({
    userId,
    sourceType: 'journal',
    sourceId: { $in: journals.map((journal) => journal._id) },
  })
  return new Map(values.map((highlight) => [highlight.sourceId.toString(), publicHighlight(highlight)]))
}

async function loadMediaDaySummaries(userId: Types.ObjectId, from: string, to: string) {
  const rows = await MediaAsset.aggregate<{ _id: string; count: number; first: MediaAssetDocument }>([
    { $match: { userId, ownerType: 'journal', ownerKey: { $gte: from, $lte: to }, status: 'ready' } },
    { $sort: { ownerKey: 1, createdAt: 1, _id: 1 } },
    { $group: { _id: '$ownerKey', count: { $sum: 1 }, first: { $first: '$$ROOT' } } },
    { $sort: { _id: 1 } },
  ])
  return rows.map((row) => ({ count: row.count, date: row._id, first: row.first }))
}

async function loadMediaDaySummariesForDates(userId: Types.ObjectId, dates: string[]) {
  if (dates.length === 0) return []
  const rows = await MediaAsset.aggregate<{ _id: string; count: number; first: MediaAssetDocument }>([
    { $match: { userId, ownerType: 'journal', ownerKey: { $in: dates }, status: 'ready' } },
    { $sort: { ownerKey: 1, createdAt: 1, _id: 1 } },
    { $group: { _id: '$ownerKey', count: { $sum: 1 }, first: { $first: '$$ROOT' } } },
  ])
  return rows.map((row) => ({ count: row.count, date: row._id, first: row.first }))
}

async function loadImagesForDates(userId: Types.ObjectId, dates: string[], maximum = THUMBNAIL_LIMIT) {
  if (dates.length === 0) return new Map<string, ReturnType<typeof imageResponse>[]>()
  const images = await MediaAsset.find({
    userId,
    ownerType: 'journal',
    ownerKey: { $in: dates },
    status: 'ready',
  }).sort({ ownerKey: 1, createdAt: 1, _id: 1 })
  const grouped = new Map<string, ReturnType<typeof imageResponse>[]>()
  for (const image of images) {
    const current = grouped.get(image.ownerKey) ?? []
    if (current.length < maximum) current.push(imageResponse(image))
    grouped.set(image.ownerKey, current)
  }
  return grouped
}

function evenlySelect<T>(values: T[], count: number) {
  if (count <= 0 || values.length === 0) return []
  if (values.length <= count) return values
  if (count === 1) return [values[Math.floor((values.length - 1) / 2)] as T]
  const indices = new Set<number>()
  for (let index = 0; index < count; index += 1) {
    indices.add(Math.round(index * (values.length - 1) / (count - 1)))
  }
  return [...indices].map((index) => values[index] as T)
}

function selectPreviewJournals(journals: JournalSummary[], highlights: Map<string, ReturnType<typeof publicHighlight>>) {
  const featured = journals.filter((journal) => highlights.has(journal._id.toString()))
  const selectedFeatured = evenlySelect(featured, Math.min(PREVIEW_DAY_LIMIT, featured.length))
  const selectedIds = new Set(selectedFeatured.map((journal) => journal._id.toString()))
  const remaining = journals.filter((journal) => !selectedIds.has(journal._id.toString()))
  return [...selectedFeatured, ...evenlySelect(remaining, PREVIEW_DAY_LIMIT - selectedFeatured.length)]
    .sort((left, right) => left.date.localeCompare(right.date))
}

function chooseExcerpt(journals: JournalSummary[], highlights: Map<string, ReturnType<typeof publicHighlight>>) {
  const withText = journals.filter((journal) => journal.contentPrefix.trim())
  const selected = withText.find((journal) => highlights.has(journal._id.toString())) ?? withText[0]
  const text = selected ? excerpt(selected.contentPrefix, selected.contentLength) : null
  return selected && text ? { date: selected.date, text } : null
}

function automaticCoverDate(journals: JournalSummary[], highlights: Map<string, ReturnType<typeof publicHighlight>>, media: Map<string, MediaDaySummary>) {
  return journals.find((journal) => highlights.has(journal._id.toString()) && media.has(journal.date))?.date
    ?? journals.find((journal) => media.has(journal.date))?.date
    ?? null
}

async function loadManualCovers(userId: Types.ObjectId, albums: JourneyAlbumDocument[]) {
  const ids = albums.flatMap((album) => album.coverImageId ? [album.coverImageId] : [])
  const images = ids.length === 0 ? [] : await MediaAsset.find({
    _id: { $in: ids },
    userId,
    ownerType: 'journal',
    status: 'ready',
  })
  return new Map(images.map((image) => [image._id.toString(), image]))
}

function resolveAlbumCover(
  album: JourneyAlbumDocument | undefined,
  from: string,
  to: string,
  manualCovers: Map<string, MediaAssetDocument>,
  automaticDate: string | null,
  mediaByDate: Map<string, MediaDaySummary>,
) {
  const selected = album?.coverImageId ? manualCovers.get(album.coverImageId.toString()) : undefined
  if (selected && selected.ownerKey >= from && selected.ownerKey <= to) {
    return { coverImage: imageResponse(selected), coverSource: 'manual' as const, selectedCoverImageId: selected._id.toString() }
  }
  const automatic = automaticDate ? mediaByDate.get(automaticDate)?.first : undefined
  return {
    coverImage: automatic ? imageResponse(automatic) : null,
    coverSource: automatic ? 'automatic' as const : 'none' as const,
    selectedCoverImageId: null,
  }
}

function dayCard(
  journal: JournalSummary,
  highlight: ReturnType<typeof publicHighlight> | undefined,
  imageCount: number,
  images: ReturnType<typeof imageResponse>[],
) {
  return {
    date: journal.date,
    excerpt: excerpt(journal.contentPrefix, journal.contentLength),
    highlight: highlight ?? null,
    imageCount,
    images,
    journalId: journal._id.toString(),
  }
}

function pagination(page: number, limit: number, total: number) {
  return { limit, page, pages: total === 0 ? 0 : Math.ceil(total / limit), total }
}

export async function journeyYear(userId: string, year: number) {
  const userIdValue = ownerId(userId)
  const from = `${year}-01-01`
  const to = `${year}-12-31`
  const [journals, mediaRows, albums] = await Promise.all([
    loadJournalSummaries(userIdValue, from, to),
    loadMediaDaySummaries(userIdValue, from, to),
    JourneyAlbum.find({ userId: userIdValue, year }).sort({ month: 1 }),
  ])
  const highlights = await loadHighlights(userIdValue, journals)
  const manualCovers = await loadManualCovers(userIdValue, albums)
  const albumByMonth = new Map(albums.map((album) => [album.month, album]))
  const mediaByDate = new Map(mediaRows.map((row) => [row.date, row]))
  return {
    months: Array.from({ length: 12 }, (_, index) => {
      const month = index + 1
      const bounds = monthBounds(year, month)
      const monthJournals = journals.filter((journal) => journal.date >= bounds.from && journal.date <= bounds.to)
      const album = albumByMonth.get(month)
      const cover = resolveAlbumCover(
        album,
        bounds.from,
        bounds.to,
        manualCovers,
        automaticCoverDate(monthJournals, highlights, mediaByDate),
        mediaByDate,
      )
      return {
        ...cover,
        customTitle: album?.title ?? '',
        dayCount: monthJournals.length,
        excerpt: chooseExcerpt(monthJournals, highlights),
        imageCount: monthJournals.reduce((total, journal) => total + (mediaByDate.get(journal.date)?.count ?? 0), 0),
        month,
        title: album?.title || `Tháng ${month}`,
      }
    }),
    year,
  }
}

export async function journeyMonth(userId: string, year: number, month: number) {
  const userIdValue = ownerId(userId)
  const bounds = monthBounds(year, month)
  const [journals, mediaRows, album] = await Promise.all([
    loadJournalSummaries(userIdValue, bounds.from, bounds.to),
    loadMediaDaySummaries(userIdValue, bounds.from, bounds.to),
    JourneyAlbum.findOne({ userId: userIdValue, year, month }),
  ])
  const highlights = await loadHighlights(userIdValue, journals)
  const previewJournals = selectPreviewJournals(journals, highlights)
  const imagesByDate = await loadImagesForDates(userIdValue, previewJournals.map((journal) => journal.date))
  const mediaByDate = new Map(mediaRows.map((row) => [row.date, row]))
  const manualCovers = await loadManualCovers(userIdValue, album ? [album] : [])
  return {
    album: {
      ...resolveAlbumCover(
        album ?? undefined,
        bounds.from,
        bounds.to,
        manualCovers,
        automaticCoverDate(journals, highlights, mediaByDate),
        mediaByDate,
      ),
      customTitle: album?.title ?? '',
      dayCount: journals.length,
      excerpt: chooseExcerpt(journals, highlights),
      imageCount: mediaRows.reduce((total, row) => total + row.count, 0),
      month,
      title: album?.title || `Tháng ${month}`,
      year,
    },
    previewDays: previewJournals.map((journal) => dayCard(
      journal,
      highlights.get(journal._id.toString()),
      mediaByDate.get(journal.date)?.count ?? 0,
      imagesByDate.get(journal.date) ?? [],
    )),
  }
}

async function listDaysInRange(userIdValue: Types.ObjectId, from: string, to: string, page: number, limit: number) {
  const filter = { userId: userIdValue, date: { $gte: from, $lte: to } }
  const [documents, total] = await Promise.all([
    Journal.find(filter).sort({ date: 1, _id: 1 }).skip((page - 1) * limit).limit(limit),
    Journal.countDocuments(filter),
  ])
  const journals: JournalSummary[] = documents.map((journal) => ({
    _id: journal._id,
    contentLength: Array.from(journal.content).length,
    contentPrefix: Array.from(journal.content).slice(0, EXCERPT_LENGTH + 1).join(''),
    createdAt: journal.createdAt,
    date: journal.date,
    updatedAt: journal.updatedAt,
    version: journal.version,
  }))
  const [highlights, mediaRows, imagesByDate] = await Promise.all([
    loadHighlights(userIdValue, journals),
    loadMediaDaySummariesForDates(userIdValue, journals.map((journal) => journal.date)),
    loadImagesForDates(userIdValue, journals.map((journal) => journal.date)),
  ])
  const mediaByDate = new Map(mediaRows.map((row) => [row.date, row]))
  return {
    days: journals.map((journal) => dayCard(
      journal,
      highlights.get(journal._id.toString()),
      mediaByDate.get(journal.date)?.count ?? 0,
      imagesByDate.get(journal.date) ?? [],
    )),
    from,
    pagination: pagination(page, limit, total),
    to,
  }
}

export async function journeyDays(userId: string, input: JourneyTimelineInput) {
  return listDaysInRange(ownerId(userId), input.from, input.to, input.page, input.limit)
}

export async function journeyDay(userId: string, date: string) {
  const userIdValue = ownerId(userId)
  const journal = await Journal.findOne({ userId: userIdValue, date })
  if (!journal) return { date, entry: null }
  const [highlight, images] = await Promise.all([
    JourneyHighlight.findOne({ userId: userIdValue, sourceType: 'journal', sourceId: journal._id }),
    MediaAsset.find({ userId: userIdValue, ownerType: 'journal', ownerKey: date, status: 'ready' }).sort({ createdAt: 1, _id: 1 }),
  ])
  return {
    date,
    entry: {
      content: journal.content,
      createdAt: journal.createdAt.toISOString(),
      date,
      highlight: highlight ? publicHighlight(highlight) : null,
      images: images.map(imageResponse),
      journalId: journal._id.toString(),
      updatedAt: journal.updatedAt.toISOString(),
      version: journal.version,
    },
  }
}

export async function updateJourneyAlbum(userId: string, year: number, month: number, input: JourneyAlbumInput) {
  const userIdValue = ownerId(userId)
  const bounds = monthBounds(year, month)
  if (input.coverImageId && !await MediaAsset.exists({
    _id: input.coverImageId,
    userId: userIdValue,
    ownerType: 'journal',
    ownerKey: { $gte: bounds.from, $lte: bounds.to },
    status: 'ready',
  })) throw new JourneyInputError('Ảnh bìa phải là ảnh nhật ký của chính bạn trong tháng này.')
  if (!input.title && input.coverImageId === null) {
    await JourneyAlbum.deleteOne({ userId: userIdValue, year, month })
  } else {
    await JourneyAlbum.updateOne(
      { userId: userIdValue, year, month },
      { $set: { coverImageId: input.coverImageId ? new Types.ObjectId(input.coverImageId) : null, title: input.title }, $setOnInsert: { userId: userIdValue, year, month } },
      { upsert: true },
    )
  }
  return journeyMonth(userId, year, month)
}

export async function journeyCoverOptions(userId: string, input: JourneyTimelineInput) {
  const userIdValue = ownerId(userId)
  const filter = {
    userId: userIdValue,
    ownerType: 'journal' as const,
    ownerKey: { $gte: input.from, $lte: input.to },
    status: 'ready' as const,
  }
  const [images, total] = await Promise.all([
    MediaAsset.find(filter).sort({ ownerKey: 1, createdAt: 1, _id: 1 }).skip((input.page - 1) * input.limit).limit(input.limit),
    MediaAsset.countDocuments(filter),
  ])
  return {
    images: images.map((image) => ({ date: image.ownerKey, image: imageResponse(image) })),
    pagination: pagination(input.page, input.limit, total),
  }
}

export async function createJourneyHighlight(userId: string, input: JourneyHighlightInput) {
  const userIdValue = ownerId(userId)
  if (!await Journal.exists({ _id: input.sourceId, userId: userIdValue })) {
    throw new JourneyNotFoundError('Không tìm thấy nhật ký để đánh dấu.')
  }
  const result = await JourneyHighlight.updateOne(
    { userId: userIdValue, sourceType: 'journal', sourceId: input.sourceId },
    { $setOnInsert: { userId: userIdValue, sourceType: 'journal', sourceId: input.sourceId } },
    { upsert: true },
  )
  const highlight = await JourneyHighlight.findOne({ userId: userIdValue, sourceType: 'journal', sourceId: input.sourceId })
  if (!highlight) throw new Error('Journey highlight upsert returned no document')
  return { created: result.upsertedCount === 1, highlight: publicHighlight(highlight) }
}

export async function deleteJourneyHighlight(userId: string, highlightId: string) {
  const result = await JourneyHighlight.deleteOne({ _id: highlightId, userId: ownerId(userId), sourceType: 'journal' })
  if (result.deletedCount !== 1) throw new JourneyNotFoundError('Không tìm thấy ký ức nổi bật.')
}

async function validPhaseCover(userId: Types.ObjectId, imageId: Types.ObjectId | null, startDate: string, endDate: string) {
  if (!imageId) return null
  return MediaAsset.findOne({
    _id: imageId,
    userId,
    ownerType: 'journal',
    ownerKey: { $gte: startDate, $lte: endDate },
    status: 'ready',
  })
}

async function publicPhase(userId: Types.ObjectId, phase: JourneyPhaseDocument) {
  const cover = await validPhaseCover(userId, phase.coverImageId, phase.startDate, phase.endDate)
  return {
    coverImage: cover ? imageResponse(cover) : null,
    coverImageId: cover?._id.toString() ?? null,
    createdAt: phase.createdAt.toISOString(),
    endDate: phase.endDate,
    id: phase._id.toString(),
    introduction: phase.introduction,
    name: phase.name,
    startDate: phase.startDate,
    summary: phase.summary,
    updatedAt: phase.updatedAt.toISOString(),
  }
}

async function ensurePhaseCover(userId: Types.ObjectId, imageId: string | null, startDate: string, endDate: string) {
  if (imageId === null) return null
  const image = await validPhaseCover(userId, new Types.ObjectId(imageId), startDate, endDate)
  if (!image) throw new JourneyInputError('Ảnh bìa phải là ảnh nhật ký của chính bạn trong khoảng giai đoạn.')
  return image._id
}

export async function listJourneyPhases(userId: string) {
  const userIdValue = ownerId(userId)
  const phases = await JourneyPhase.find({ userId: userIdValue }).sort({ startDate: -1, endDate: -1, _id: -1 }).limit(100)
  return { phases: await Promise.all(phases.map((phase) => publicPhase(userIdValue, phase))) }
}

export async function createJourneyPhase(userId: string, input: JourneyPhaseInput) {
  const userIdValue = ownerId(userId)
  const phase = await JourneyPhase.create({
    ...input,
    coverImageId: await ensurePhaseCover(userIdValue, input.coverImageId, input.startDate, input.endDate),
    userId: userIdValue,
  })
  return publicPhase(userIdValue, phase)
}

export async function updateJourneyPhase(userId: string, phaseId: string, input: JourneyPhaseUpdateInput) {
  const userIdValue = ownerId(userId)
  const phase = await JourneyPhase.findOne({ _id: phaseId, userId: userIdValue })
  if (!phase) throw new JourneyNotFoundError('Không tìm thấy giai đoạn.')
  const startDate = input.startDate ?? phase.startDate
  const endDate = input.endDate ?? phase.endDate
  if (endDate < startDate) throw new JourneyInputError('endDate phải bằng hoặc sau startDate.')
  if ('coverImageId' in input) phase.coverImageId = await ensurePhaseCover(userIdValue, input.coverImageId ?? null, startDate, endDate)
  else if (!await validPhaseCover(userIdValue, phase.coverImageId, startDate, endDate)) phase.coverImageId = null
  if (input.name !== undefined) phase.name = input.name
  if (input.startDate !== undefined) phase.startDate = input.startDate
  if (input.endDate !== undefined) phase.endDate = input.endDate
  if (input.introduction !== undefined) phase.introduction = input.introduction
  if (input.summary !== undefined) phase.summary = input.summary
  await phase.save()
  return publicPhase(userIdValue, phase)
}

export async function journeyPhaseDays(userId: string, phaseId: string, page: number, limit: number) {
  const userIdValue = ownerId(userId)
  const phase = await JourneyPhase.findOne({ _id: phaseId, userId: userIdValue })
  if (!phase) throw new JourneyNotFoundError('Không tìm thấy giai đoạn.')
  return listDaysInRange(userIdValue, phase.startDate, phase.endDate, page, limit)
}

export async function deleteJourneyPhase(userId: string, phaseId: string) {
  const result = await JourneyPhase.deleteOne({ _id: phaseId, userId: ownerId(userId) })
  if (result.deletedCount !== 1) throw new JourneyNotFoundError('Không tìm thấy giai đoạn.')
}
