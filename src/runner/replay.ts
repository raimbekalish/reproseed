import { errors, type Browser, type BrowserContext } from "playwright";

import type {
  ExecutionOutcome,
  Probe,
  Scenario,
  Signature,
} from "../core/types.ts";
import { executeAction } from "./actions.ts";
import { installMatchedResponseDelay, installOriginGuard, type ResponseDelay } from "./faults.ts";
import { recordCountOutcome } from "./oracle.ts";
import { prepareReplay, type PreparedReplay } from "./plan.ts";
import { readRecordList, resetAndConfirmEmpty, ResetFailed, type FetchLike } from "./reset.ts";
import { assertPageStayed } from "./safety.ts";
import { createBrowserPool, launchChromium, type BrowserPool } from "./session.ts";
import { trackOriginRequests } from "./settle.ts";
import {
  bounded,
  CLEANUP_BUDGET_MS,
  errorMessage,
  isAbortLike,
  ReplayTimeout,
  throwIfAborted,
} from "./timing.ts";

export type ReplayRuntime = {
  /** Returns a Probe bound to one scenario. Replays on this runtime run one at a time. */
  probeFor: (scenario: Scenario) => Probe;
  currentBrowser: () => ReturnType<BrowserPool["current"]>;
  close: () => Promise<void>;
};

export function startReplayRuntime(options?: {
  fetchImpl?: FetchLike;
  launchBrowser?: () => Promise<Browser>;
}): ReplayRuntime {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const pool = createBrowserPool(options?.launchBrowser ?? launchChromium);
  let queue: Promise<void> = Promise.resolve();
  let closed = false;

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    currentBrowser: () => pool.current(),
    probeFor: (scenario) => {
      const probe: Probe = async (stepIds) => {
        if (closed) {
          return runnerOutcome(0, "replay runtime is closed");
        }
        let prepared: PreparedReplay;
        try {
          prepared = prepareReplay(scenario, stepIds);
        } catch (error) {
          return runnerOutcome(0, error);
        }
        return enqueue(async () => {
          const startedAt = Date.now();
          try {
            if (closed) {
              return runnerOutcome(0, "replay runtime is closed");
            }
            return await executePrepared(prepared, startedAt, pool, fetchImpl);
          } catch (error) {
            return classifyFailure(error, Date.now() - startedAt, false, new AbortController().signal);
          }
        });
      };
      return probe;
    },
    close: async () => {
      await enqueue(async () => {
        closed = true;
        await pool.close();
      });
    },
  };
}

async function executePrepared(
  prepared: PreparedReplay,
  startedAt: number,
  pool: BrowserPool,
  fetchImpl: FetchLike,
): Promise<ExecutionOutcome> {
  const { scenario, origin, steps } = prepared;
  const timeoutMs = scenario.budget.attemptTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const delays: ResponseDelay[] = [];
  let context: BrowserContext | undefined;
  let contextClose: Promise<string | undefined> | undefined;
  let browserDisconnected = false;
  let outcome: ExecutionOutcome | undefined;

  const closeContext = (): Promise<string | undefined> => {
    if (contextClose !== undefined) {
      return contextClose;
    }
    const current = context;
    if (current === undefined) {
      return Promise.resolve(undefined);
    }
    contextClose = (async () => {
      try {
        await bounded(current.close(), CLEANUP_BUDGET_MS, "browser context cleanup timed out");
        return undefined;
      } catch (error) {
        return errorMessage(error);
      }
    })();
    return contextClose;
  };

  const onAbort = (): void => {
    for (const delay of delays) {
      void delay.dispose().catch(() => undefined);
    }
    void closeContext();
  };
  controller.signal.addEventListener("abort", onAbort);

  let detachDisconnect: (() => void) | undefined;
  try {
    throwIfAborted(controller.signal);
    await resetAndConfirmEmpty({
      origin,
      expectedAppId: scenario.target.appId,
      resetAuthorization: scenario.target.resetAuthorization,
      fetchImpl,
      signal: controller.signal,
    });
    const browser = await pool.acquire();
    const onDisconnect = (): void => {
      browserDisconnected = true;
      controller.abort();
    };
    browser.on("disconnected", onDisconnect);
    detachDisconnect = () => {
      browser.off("disconnected", onDisconnect);
    };
    throwIfAborted(controller.signal);
    context = await browser.newContext();
    if (controller.signal.aborted) {
      throw new ReplayTimeout();
    }
    const actionBudget = Math.max(1, timeoutMs - (Date.now() - startedAt));
    context.setDefaultTimeout(actionBudget);
    context.setDefaultNavigationTimeout(actionBudget);
    await installOriginGuard(context, origin);
    const page = await context.newPage();
    const tracker = trackOriginRequests(page, origin);
    try {
      for (const step of steps) {
        throwIfAborted(controller.signal);
        if (step.kind === "delay") {
          delays.push(
            await installMatchedResponseDelay(context, {
              origin,
              urlIncludes: step.urlIncludes,
              method: step.method,
              ms: step.ms,
              signal: controller.signal,
            }),
          );
          assertPageStayed(page.url(), origin, true);
          continue;
        }
        await executeAction(page, step, {
          origin,
          signal: controller.signal,
          startedAt,
          timeoutMs,
        });
      }
      await tracker.waitUntilSettled(controller.signal);
      const records = await readRecordList({
        origin,
        path: scenario.oracle.request.path,
        fetchImpl,
        signal: controller.signal,
      });
      const actual = records.filter((record) => record.email === scenario.oracle.match.value).length;
      outcome = recordCountOutcome({
        email: scenario.oracle.match.value,
        actual,
        expect: scenario.oracle.expect,
        durationMs: Date.now() - startedAt,
      });
    } finally {
      tracker.dispose();
    }
  } catch (error) {
    outcome = classifyFailure(error, Date.now() - startedAt, browserDisconnected, controller.signal);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    detachDisconnect?.();
    const notes: string[] = [];
    for (const delay of delays) {
      try {
        await bounded(delay.dispose(), CLEANUP_BUDGET_MS, "delay cleanup timed out");
      } catch (error) {
        notes.push(errorMessage(error));
      }
    }
    const contextNote = await closeContext();
    if (contextNote !== undefined) {
      notes.push(contextNote);
    }
    const cleanupFailure = notes.length > 0 ? notes.join("; ") : undefined;
    outcome = withCleanup(outcome ?? runnerOutcome(Date.now() - startedAt, "replay produced no outcome"), cleanupFailure);
    outcome = { ...outcome, durationMs: Math.max(0, Date.now() - startedAt) };
  }
  return outcome;
}

function classifyFailure(
  error: unknown,
  durationMs: number,
  browserDisconnected: boolean,
  signal: AbortSignal,
): ExecutionOutcome {
  if (browserDisconnected) {
    return runnerOutcome(durationMs, "browser closed during replay");
  }
  if (isAbortLike(error, signal) || error instanceof errors.TimeoutError) {
    return timeoutOutcome(durationMs, "attempt timed out");
  }
  if (error instanceof ResetFailed) {
    return runnerOutcome(durationMs, error, "RESET_FAILED");
  }
  return runnerOutcome(durationMs, error);
}

function timeoutOutcome(durationMs: number, message: string): ExecutionOutcome {
  return {
    status: "timeout",
    durationMs,
    error: message,
    signature: runnerSignature("TIMEOUT", message),
  };
}

function runnerOutcome(
  durationMs: number,
  error: unknown,
  code: "RUNNER_ERROR" | "RESET_FAILED" = "RUNNER_ERROR",
): ExecutionOutcome {
  const message = typeof error === "string" ? error : errorMessage(error);
  return {
    status: "error",
    durationMs,
    error: message,
    signature: runnerSignature(code, message),
  };
}

function runnerSignature(code: "TIMEOUT" | "RUNNER_ERROR" | "RESET_FAILED", message: string): Signature {
  return {
    oracleId: "runner",
    code,
    facts: { message },
  };
}

function withCleanup(outcome: ExecutionOutcome, cleanupFailure: string | undefined): ExecutionOutcome {
  if (cleanupFailure === undefined) {
    return outcome;
  }
  const note = `cleanup failed: ${cleanupFailure}`;
  if (outcome.status === "timeout") {
    const message = outcome.error === undefined ? note : `${outcome.error}; ${note}`;
    return timeoutOutcome(outcome.durationMs, message);
  }
  const message =
    outcome.status === "pass"
      ? `oracle passed but ${note}`
      : outcome.status === "fail"
        ? `oracle reported ${outcome.signature.code} but ${note}`
        : `${outcome.error ?? "runner error"}; ${note}`;
  return runnerOutcome(outcome.durationMs, message);
}
