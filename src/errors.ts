/** An error the CLI reports as exit code 2 (usage error, server error, or API error). */
export class FootprintError extends Error {
  override readonly name: string = 'FootprintError';
}

/** A deadline passed while waiting on the server. */
export class TimeoutError extends FootprintError {
  override readonly name = 'TimeoutError';
}

/** Bad command-line arguments. */
export class UsageError extends FootprintError {
  override readonly name = 'UsageError';
}
