import { Worker } from "node:worker_threads";
import { env } from "@langfuse/shared/src/env";
import {
  assertDispatchResultWithinByteLimit,
  CodeEvalDispatcherError,
  CodeEvalDispatcherErrorCodes,
  parseRunDispatchResult,
  withCodeEvalDocs,
  type CodeEvalDispatcher,
  type CodeEvalPayload,
  type DispatchInput,
  type DispatchResult,
} from "@langfuse/shared/src/server";

/**
 * Worker-thread dispatcher for the ad-hoc run endpoint.
 *
 * `insecure-local` executes evaluator code synchronously in `vm.runInContext`,
 * which blocks whichever event loop runs it. That is fine for the worker
 * container (queue-driven jobs), but not for the web process: one slow script
 * would stall every other request. Here each run gets a worker thread instead,
 * so the web event loop stays responsive, the concurrency gate bounds in-flight
 * work, and a runaway script can be killed without taking the process down.
 */

const SCRIPT_TIMEOUT_MESSAGE = "Script execution timed out";
/** Parent-side deadline over the script budget. */
const DEADLINE_SLACK_MS = 1_000;
/** Idle threads are dropped so a burst does not pin memory forever. */
const IDLE_TTL_MS = 60_000;
/** Per-thread heap cap: isolation for the web process, not a reservation. */
const HEAP_LIMIT_MB = 128;

/**
 * Inline worker source.
 *
 * It imports nothing from the app on purpose: the server build is
 * `output: "standalone"` with `@langfuse/shared` transpiled into the route
 * chunks, so a worker spawned from a file path could not resolve it. Contract
 * work (payload shape, result validation, error codes) stays in the parent and
 * in `@langfuse/shared`; this script only strips types, runs the code in a vm,
 * and reports which phase failed.
 */
const WORKER_SOURCE = `
const vm = require("node:vm");
const { stripTypeScriptTypes } = require("node:module");
const { parentPort } = require("node:worker_threads");

const TIMEOUT_MESSAGE = ${JSON.stringify(SCRIPT_TIMEOUT_MESSAGE)};

// Errors cross the vm realm boundary, so describe them structurally.
function describe(error) {
  if (typeof error === "object" && error !== null) {
    const name = typeof error.name === "string" ? error.name : undefined;
    const message =
      typeof error.message === "string" ? error.message : String(error);
    return { name, message: name && name !== "Error" ? name + ": " + message : message };
  }
  return { message: String(error) };
}

function fail(phase, error) {
  parentPort.postMessage({ ok: false, phase, ...describe(error) });
}

function context(payload) {
  return vm.createContext({
    payload,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
  });
}

parentPort.on("message", async ({ source, payload, timeoutMs }) => {
  let script;
  try {
    script = stripTypeScriptTypes(source, { mode: "strip" });
  } catch (error) {
    return fail("prepare", error);
  }

  const scope = context(payload);
  try {
    vm.runInContext(
      script +
        '\\nif (typeof evaluate !== "function") {' +
        ' throw new Error("Evaluator source must define evaluate(ctx)"); }',
      scope,
      { timeout: timeoutMs },
    );
  } catch (error) {
    return fail("prepare", error);
  }

  let timer;
  try {
    const value = await Promise.race([
      vm.runInContext("evaluate(payload)", scope, { timeout: timeoutMs }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(TIMEOUT_MESSAGE + " after " + timeoutMs + "ms")),
          timeoutMs,
        );
      }),
    ]);
    parentPort.postMessage({ ok: true, value });
  } catch (error) {
    const info = describe(error);
    parentPort.postMessage({
      ok: false,
      phase: info.message.includes(TIMEOUT_MESSAGE) ? "timeout" : "execute",
      ...info,
    });
  } finally {
    clearTimeout(timer);
  }
});
`;

type Task = {
  source: string;
  payload: CodeEvalPayload;
  timeoutMs: number;
};

type Reply =
  | { ok: true; value: unknown }
  | {
      ok: false;
      phase: "prepare" | "execute" | "timeout";
      name?: string;
      message: string;
    };

type Job = {
  timer: NodeJS.Timeout;
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
};

/**
 * Bounded pool of worker threads, one task per thread at a time. Its ceiling is
 * the run endpoint's concurrency gate, so an accepted request never waits for a
 * thread. Threads are created on demand and recycled after idling, which keeps
 * the footprint proportional to traffic rather than to the ceiling.
 */
class CodeEvalWorkerPool {
  private readonly size: number;
  private readonly workers = new Set<Worker>();
  private readonly idle: Worker[] = [];
  private readonly idleTimers = new Map<Worker, NodeJS.Timeout>();
  private readonly jobByWorker = new Map<Worker, Job>();

  constructor(size: number) {
    this.size = Math.max(1, size);
  }

  run(task: Task): Promise<Reply> {
    const worker = this.idle.pop() ?? this.spawn();
    if (!worker) {
      // Unreachable through the endpoint (gate == pool size); surface it loudly.
      return Promise.reject(new Error("Code eval worker pool is exhausted"));
    }
    this.clearIdleTimer(worker);

    return new Promise<Reply>((resolve, reject) => {
      // The worker enforces `timeoutMs` itself. This deadline is the parent's
      // guarantee that a silent worker still frees its slot instead of holding
      // the request forever.
      const timer = setTimeout(() => {
        this.jobByWorker.delete(worker);
        // The script is beyond its budget: drop the thread instead of waiting.
        this.retire(worker, { terminate: true });
        resolve({
          ok: false,
          phase: "timeout",
          message: `${SCRIPT_TIMEOUT_MESSAGE} after ${task.timeoutMs}ms`,
        });
      }, task.timeoutMs + DEADLINE_SLACK_MS);
      timer.unref();

      this.jobByWorker.set(worker, { timer, resolve, reject });
      worker.postMessage({
        source: task.source,
        payload: task.payload,
        timeoutMs: task.timeoutMs,
      });
    });
  }

  private spawn(): Worker | undefined {
    if (this.workers.size >= this.size) return undefined;

    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: HEAP_LIMIT_MB },
    });
    this.workers.add(worker);
    worker.unref();
    worker.on("message", (reply: Reply) => this.onReply(worker, reply));
    worker.on("error", (error) => this.onCrash(worker, error));
    worker.on("exit", () => this.retire(worker));
    return worker;
  }

  private onReply(worker: Worker, reply: Reply) {
    const job = this.jobByWorker.get(worker);
    // A reply that arrives after the deadline has already been answered.
    if (!job) return;

    this.jobByWorker.delete(worker);
    clearTimeout(job.timer);
    this.release(worker);
    job.resolve(reply);
  }

  private onCrash(worker: Worker, error: unknown) {
    this.retire(worker);

    const job = this.jobByWorker.get(worker);
    if (!job) return;
    this.jobByWorker.delete(worker);
    clearTimeout(job.timer);
    job.reject(
      isOutOfMemory(error)
        ? new CodeEvalDispatcherError(
            "Evaluator exceeded the worker memory limit",
            { code: CodeEvalDispatcherErrorCodes.OUT_OF_MEMORY },
          )
        : new CodeEvalDispatcherError(
            `Evaluator worker crashed: ${messageOf(error)}`,
            {
              code: CodeEvalDispatcherErrorCodes.USER_CODE_ERROR,
              cause: error,
            },
          ),
    );
  }

  private release(worker: Worker) {
    this.idle.push(worker);
    const timer = setTimeout(() => {
      this.clearIdleTimer(worker);
      this.retire(worker, { terminate: true });
    }, IDLE_TTL_MS);
    timer.unref();
    this.idleTimers.set(worker, timer);
  }

  private clearIdleTimer(worker: Worker) {
    const timer = this.idleTimers.get(worker);
    if (!timer) return;
    clearTimeout(timer);
    this.idleTimers.delete(worker);
  }

  /** Idempotent: a crashed worker emits both `error` and `exit`. */
  private retire(worker: Worker, options?: { terminate?: boolean }) {
    this.clearIdleTimer(worker);
    this.workers.delete(worker);
    const index = this.idle.indexOf(worker);
    if (index >= 0) this.idle.splice(index, 1);
    if (options?.terminate) {
      worker.terminate().catch(() => {
        // Already gone.
      });
    }
  }
}

/** One pool per process (and per dev-server hot reload). */
const globalForPool = globalThis as unknown as {
  codeEvalWorkerPool?: CodeEvalWorkerPool;
};

function pool(): CodeEvalWorkerPool {
  if (!globalForPool.codeEvalWorkerPool) {
    globalForPool.codeEvalWorkerPool = new CodeEvalWorkerPool(
      env.LANGFUSE_CODE_EVAL_RUN_CONCURRENCY,
    );
  }
  return globalForPool.codeEvalWorkerPool;
}

/** Dispatcher bound to one request's timeout; the pool is shared. */
export function getWorkerCodeEvalDispatcher(
  timeoutMs: number,
): CodeEvalDispatcher {
  return {
    name: "insecure-local-worker",
    async dispatch(input: DispatchInput): Promise<DispatchResult> {
      if (input.runtime.language !== "TYPESCRIPT") {
        throw new CodeEvalDispatcherError(
          "Worker code eval dispatcher only supports TypeScript/JavaScript evaluators",
          { code: CodeEvalDispatcherErrorCodes.UNSUPPORTED_RUNTIME },
        );
      }

      const reply = await pool().run({
        source: input.code.source,
        payload: input.payload,
        timeoutMs,
      });

      if (reply.ok) {
        // Runs may return long TEXT values (see CODE_EVAL_RUN_TEXT_MAX_LENGTH);
        // the shared result cap still applies before anything leaves the process.
        assertDispatchResultWithinByteLimit(
          Buffer.byteLength(JSON.stringify(reply.value)),
        );
        return parseRunDispatchResult(reply.value);
      }
      if (reply.phase === "timeout") {
        throw new CodeEvalDispatcherError(reply.message, {
          code: CodeEvalDispatcherErrorCodes.TIMEOUT,
        });
      }
      if (reply.phase === "prepare") {
        throw new CodeEvalDispatcherError(
          `Failed to prepare evaluator source: ${withCodeEvalDocs(reply.message)}`,
          { code: CodeEvalDispatcherErrorCodes.INVALID_SOURCE },
        );
      }
      throw new CodeEvalDispatcherError(withCodeEvalDocs(reply.message), {
        code: CodeEvalDispatcherErrorCodes.USER_CODE_ERROR,
      });
    },
  } satisfies CodeEvalDispatcher;
}

function isOutOfMemory(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_WORKER_OUT_OF_MEMORY"
  );
}

function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
