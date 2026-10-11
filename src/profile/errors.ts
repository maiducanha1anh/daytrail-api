export class ProfileInputError extends Error {
  override name = 'ProfileInputError'
}

export class ProfileConflictError extends Error {
  override name = 'ProfileConflictError'
}

export class ProfileNotFoundError extends Error {
  override name = 'ProfileNotFoundError'
}
