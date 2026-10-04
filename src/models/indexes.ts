import { Journal } from './Journal.js'
import { Session } from './Session.js'
import { Task } from './Task.js'
import { TaskSeries } from './TaskSeries.js'
import { User } from './User.js'

export async function ensureDatabaseIndexes() {
  await Promise.all([User.createIndexes(), Session.createIndexes(), Task.createIndexes(), TaskSeries.createIndexes(), Journal.createIndexes()])
}
