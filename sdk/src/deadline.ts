// One abort scope per SDK call. It merges the caller's AbortSignal with the
// call's `timeoutMs` into a single signal handed to every fetch the call makes
// (upload, polls, result download), and turns whatever stopped the call into
// a BasisError with the right code. Built by hand rather than with
// AbortSignal.any/timeout so it behaves the same on every runtime we target.
import { BasisError } from "./errors.ts";

export interface CallOptions {
  /** Cancels the call. The SDK throws `BasisError` with code `"aborted"`. */
  signal?: AbortSignal;
  /**
   * Upper bound for the whole call in milliseconds: upload, server work,
   * polling and reading the response. `Infinity` disables it. Defaults to the
   * client's `timeoutMs`.
   */
  timeoutMs?: number;
}

const TIMEOUT = Symbol("basis.timeout");

export class Deadline {
  public readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timeoutMs: number;
  private readonly callerSignal?: AbortSignal;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly onCallerAbort = (): void => this.controller.abort(this.callerSignal?.reason);

  public constructor(timeoutMs: number, callerSignal?: AbortSignal) {
    if (!(timeoutMs > 0)) throw new RangeError(`timeoutMs must be positive, got ${timeoutMs}`);
    this.timeoutMs = timeoutMs;
    this.callerSignal = callerSignal;
    this.signal = this.controller.signal;
    if (callerSignal?.aborted) {
      this.controller.abort(callerSignal.reason);
      return;
    }
    callerSignal?.addEventListener("abort", this.onCallerAbort, { once: true });
    if (Number.isFinite(timeoutMs)) {
      this.timer = setTimeout(() => this.controller.abort(TIMEOUT), timeoutMs);
    }
  }

  /** Releases the timer and listener. Safe to call more than once. */
  public dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.callerSignal?.removeEventListener("abort", this.onCallerAbort);
  }

  /** Throws the matching BasisError if the call has been stopped. */
  public throwIfStopped(): void {
    if (this.signal.aborted) throw this.stoppedError();
  }

  /**
   * Converts an error thrown by fetch or a body read into a BasisError. An
   * abort we caused becomes `timeout`/`aborted`; other fetch failures become
   * `network_error`. BasisErrors pass through untouched.
   */
  public translate(err: unknown): BasisError {
    if (err instanceof BasisError) return err;
    if (this.signal.aborted) return this.stoppedError();
    const message = err instanceof Error ? err.message : String(err);
    return new BasisError(`request to the Basis API failed: ${message}`, "network_error", { cause: err });
  }

  /**
   * For errors from outside an HTTP exchange (argument checks, reading a
   * file): reports a stop if the call was stopped, otherwise rethrows as is.
   */
  public settle(err: unknown): unknown {
    if (err instanceof BasisError) return err;
    return this.signal.aborted ? this.stoppedError() : err;
  }

  /** Resolves after `ms`, or rejects as soon as the call is stopped. */
  public sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.signal.aborted) {
        reject(this.stoppedError());
        return;
      }
      const onAbort = (): void => {
        clearTimeout(t);
        reject(this.stoppedError());
      };
      const t = setTimeout(() => {
        this.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private stoppedError(): BasisError {
    if (this.signal.reason === TIMEOUT) {
      return new BasisError(`Basis API call did not finish within ${this.timeoutMs}ms`, "timeout");
    }
    return new BasisError("Basis API call was aborted", "aborted", { cause: this.signal.reason });
  }
}
