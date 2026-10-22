const MAX_TIMEOUT_SLICE_MS = 1_000;

export const CLEANUP_BUDGET_MS = 5_000;

export class ReplayTimeout extends Error {
  constructor(message = "attempt timed out") {
    super(message);
    this.name = "ReplayTimeout";
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ReplayTimeout();
  }
}

export function isAbortLike(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) {
    return true;
  }
  return error instanceof ReplayTimeout || (error instanceof Error && error.name === "AbortError");
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== "") {
    const cause = error.cause instanceof Error ? error.cause.message : undefined;
    if (cause !== undefined && cause !== "" && !error.message.includes(cause)) {
      return `${error.message}: ${cause}`;
    }
    return error.message;
  }
  return String(error);
}

/** Abortable wait. Long durations are sliced so a timer cannot overflow. */
export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  let remaining = ms;
  while (remaining > 0) {
    throwIfAborted(signal);
    const slice = Math.min(remaining, MAX_TIMEOUT_SLICE_MS);
    await sleepSlice(slice, signal);
    remaining -= slice;
  }
}

export function bounded(task: Promise<void>, ms: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    task.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(errorMessage(error)));
      },
    );
  });
}

function sleepSlice(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ReplayTimeout());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ReplayTimeout());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
