export class AppError extends Error {
    statusCode;
    code;
    details;
    constructor(statusCode, code, message, details) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        this.name = 'AppError';
    }
}
export const errors = {
    unauthorized: (msg = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', msg),
    forbidden: (msg = 'You do not have permission to perform this action') => new AppError(403, 'FORBIDDEN', msg),
    notFound: (msg = 'Resource not found') => new AppError(404, 'NOT_FOUND', msg),
    conflict: (msg) => new AppError(409, 'CONFLICT', msg),
    badRequest: (msg, details) => new AppError(400, 'BAD_REQUEST', msg, details),
    rateLimited: (msg = 'Too many requests') => new AppError(429, 'RATE_LIMITED', msg),
};
//# sourceMappingURL=errors.js.map