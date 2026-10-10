export class AppError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
  static badRequest(msg = 'Bad request', details) { return new AppError(400, 'BAD_REQUEST', msg, details); }
  static unauthorized(msg = 'Authentication required') { return new AppError(401, 'UNAUTHORIZED', msg); }
  static forbidden(msg = 'You do not have permission to perform this action') { return new AppError(403, 'FORBIDDEN', msg); }
  static notFound(msg = 'Resource not found') { return new AppError(404, 'NOT_FOUND', msg); }
  static conflict(msg = 'Conflict') { return new AppError(409, 'CONFLICT', msg); }
}
