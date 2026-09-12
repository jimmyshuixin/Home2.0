export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly fields?: Record<string, string[]>) { super(message); }
}
export function assert(condition: unknown, code: string, status: number, message: string): asserts condition {
  if (!condition) throw new ApiError(code, status, message);
}
