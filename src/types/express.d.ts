declare global {
  namespace Express {
    interface Request {
      auth?: {
        sessionId: string
        userId: string
      }
    }
  }
}

export {}
