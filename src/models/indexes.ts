import { Journal } from './Journal.js'
import { JourneyAlbum } from './JourneyAlbum.js'
import { JourneyHighlight } from './JourneyHighlight.js'
import { JourneyPhase } from './JourneyPhase.js'
import { MediaAsset } from './MediaAsset.js'
import { Session } from './Session.js'
import { Task } from './Task.js'
import { TaskSeries } from './TaskSeries.js'
import { User } from './User.js'

export async function ensureDatabaseIndexes() {
  await Promise.all([
    User.createIndexes(),
    Session.createIndexes(),
    Task.createIndexes(),
    TaskSeries.createIndexes(),
    Journal.createIndexes(),
    MediaAsset.createIndexes(),
    JourneyAlbum.createIndexes(),
    JourneyHighlight.createIndexes(),
    JourneyPhase.createIndexes(),
  ])
}
