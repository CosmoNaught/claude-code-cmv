import { error as displayError } from './display.js';

export class CmvError extends Error {
  constructor(
    public userMessage: string,
    message?: string
  ) {
    super(message || userMessage);
    this.name = 'CmvError';
  }
}

/**
 * Global error handler for CLI commands.
 * Shows userMessage to user; full stack only with CMV_DEBUG=1.
 */
export function handleError(err: unknown): never {
  if (err instanceof CmvError) {
    displayError(err.userMessage);
  } else if (err instanceof Error) {
    displayError(err.message);
  } else {
    displayError(String(err));
  }

  if (process.env['CMV_DEBUG'] === '1' && err instanceof Error) {
    console.error('\nDebug stack trace:');
    console.error(err.stack);
  }

  process.exit(1);
}
