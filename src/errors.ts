/** What went wrong, in the terms of the packages that call this one. */
export type ModelsKind = "fetch" | "digest" | "validate" | "backend" | "request";

/** A refusal or failure of a model file's fetch, check or storage. */
export class ModelsError extends Error {
  readonly kind: ModelsKind;
  /** Set when the file is simply absent: not on the Hub (404) or not cached while offline. */
  readonly missing?: "not-found" | "offline-uncached";
  constructor(kind: ModelsKind, message: string, missing?: "not-found" | "offline-uncached") {
    super(message);
    this.name = "ModelsError";
    this.kind = kind;
    if (missing !== undefined) this.missing = missing;
  }
}
