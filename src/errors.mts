/** A command was called wrongly; the CLI exits with 2 instead of 1. */
export class UsageError extends Error {
  override name = "UsageError";
}
