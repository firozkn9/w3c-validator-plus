export type TraceLevel = "off" | "info" | "verbose";

/** Logging interface used by engine code; the extension backs it with an OutputChannel. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
  verbose(message: string): void;
}

export const nullLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  verbose() {},
};

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  return String(err);
}
