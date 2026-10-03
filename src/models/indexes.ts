import { Session } from './Session.js'
import { Task } from './Task.js'
import { User } from './User.js'

export async function ensureDatabaseIndexes() {
  await Promise.all([User.createIndexes(), Session.createIndexes(), Task.createIndexes()])
}
