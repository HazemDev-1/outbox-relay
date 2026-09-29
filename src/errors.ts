/** Invalid input or configuration. The CLI maps this to exit code 2. */
export class UsageError extends Error {
  override name = 'UsageError';
}

/** The same event key was enqueued again with a different URL or payload. */
export class EventKeyConflictError extends Error {
  override name = 'EventKeyConflictError';
  constructor(public readonly eventKey: string) {
    super(`event key "${eventKey}" already exists with a different target URL or payload`);
  }
}
