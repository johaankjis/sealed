import type { ExecutionResult } from "../../contracts/results";
import type { SandboxRuntime } from "../../contracts/sandbox";
import { SandboxError } from "../sandbox/createos";

/**
 * Serializes whole prepare -> execute -> destroy lifecycles and gives each one
 * a fresh inner runtime. Used for lib/sandbox's SingleSandboxRuntime, which
 * holds one shared-VM lease at a time and fails busy jobs closed. Queuing here
 * makes concurrent paid jobs wait their turn instead of failing.
 *
 * It sits inside AgentDeps.sandbox, so every caller of executeJob (buyer
 * polling and the Stripe webhook route) is serialized.
 */
export class SequentialSandboxRuntime implements SandboxRuntime {
  private tail: Promise<void> = Promise.resolve();
  private lifecycles = new Map<string, { runtime: SandboxRuntime; release: () => void }>();

  constructor(
    private readonly create: () => SandboxRuntime,
    private readonly maxWaitMs = 10 * 60_000
  ) {}

  async prepareDataset(datasetId: string, datasetPath: string): Promise<string> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => (release = resolve));
    const previous = this.tail;
    this.tail = previous.then(() => turn);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([
      previous.then(() => true),
      new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), this.maxWaitMs))),
    ]);
    clearTimeout(timer);
    if (!waited) {
      // Keep the queue consistent: give our turn up once the previous job ends.
      void previous.then(release);
      throw new SandboxError("SANDBOX_QUEUE_TIMEOUT");
    }

    try {
      const runtime = this.create();
      const handle = await runtime.prepareDataset(datasetId, datasetPath);
      this.lifecycles.set(handle, { runtime, release });
      return handle;
    } catch (error) {
      release();
      throw error;
    }
  }

  async execute(handle: string, code: string): Promise<ExecutionResult> {
    const lifecycle = this.lifecycles.get(handle);
    if (!lifecycle) throw new SandboxError("SANDBOX_HANDLE_UNKNOWN");
    return lifecycle.runtime.execute(handle, code);
  }

  async destroy(handle: string): Promise<void> {
    const lifecycle = this.lifecycles.get(handle);
    if (!lifecycle) return;
    try {
      await lifecycle.runtime.destroy(handle);
    } finally {
      // A quarantined inner runtime keeps its own lease, so later jobs still
      // fail closed; releasing the queue only stops them waiting forever.
      this.lifecycles.delete(handle);
      lifecycle.release();
    }
  }
}
