export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function check(condition, message, status = 400) {
  if (!condition) throw new ApiError(status, message)
}
