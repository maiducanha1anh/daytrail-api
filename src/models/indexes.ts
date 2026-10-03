import { Session } from './Session.js'
import { User } from './User.js'

export async function ensureAuthIndexes() {
  await Promise.all([User.createIndexes(), Session.createIndexes()])
}
