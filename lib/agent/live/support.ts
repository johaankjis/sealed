// Helpers for coffee-live.ts. Kept separate so config validation, resource
// tracking, and cleanup planning are unit-tested without touching CreateOS.
// Nothing outside lib/agent/live may import this directory (see
// __tests__/live-isolation.test.ts).

import type { PaymentProvider, PaymentVerification } from "../../../contracts/payments";
import type { CreateOSClient, CreateOSSandbox } from "../../sandbox/createos";
import { PROBE_HOST } from "../egress";

export class LiveUsageError extends Error {
  name = "LiveUsageError";
}

export const DEFAULT_QUESTION = "Which drink categories earn the most revenue?";

export interface LiveConfig {
  auth: { kind: "cli" } | { kind: "apiKey"; apiKey: string };
  rootfs: string;
  shape: string;
  egress: string[];
  question: string;
  timeoutMs: number;
  reportPath?: string;
}

/** Validates flags and environment. Throws LiveUsageError; never echoes secrets. */
export function parseLiveConfig(argv: string[], env: Record<string, string | undefined>): LiveConfig {
  if (!argv.includes("--run")) {
    throw new LiveUsageError("Refusing to start without --run: this creates billable CreateOS sandboxes.");
  }
  const problems: string[] = [];
  const need = (name: string) => {
    const value = env[name]?.trim();
    if (!value) problems.push(`${name} is required`);
    return value ?? "";
  };

  const cli = argv.includes("--cli-auth");
  const apiKey = cli ? "" : need("CREATEOS_SANDBOX_API_KEY");
  need("ANTHROPIC_API_KEY");
  const rootfs = need("SEALED_CREATEOS_ROOTFS");
  const egress = need("SEALED_CREATEOS_EGRESS")
    .split(",")
    .map((rule) => rule.trim())
    .filter(Boolean);
  if (env.SEALED_CREATEOS_EGRESS?.trim() && egress.length === 0) {
    problems.push("SEALED_CREATEOS_EGRESS must contain at least one rule");
  }
  if (egress.some((rule) => rule === "*" || rule.startsWith("*"))) {
    problems.push("SEALED_CREATEOS_EGRESS must not allow everything");
  }
  if (egress.some((rule) => rule.includes(PROBE_HOST))) {
    problems.push(`SEALED_CREATEOS_EGRESS must not include the probe host ${PROBE_HOST}`);
  }
  // The dataset must be the bundled synthetic fixture, never a redirected path.
  if (env.SEALED_DATA_DIR) problems.push("SEALED_DATA_DIR must be unset (synthetic fixture only)");

  const timeoutMs = Number(env.SEALED_LIVE_TIMEOUT_MS ?? 30_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    problems.push("SEALED_LIVE_TIMEOUT_MS must be an integer between 1000 and 120000");
  }

  if (problems.length) throw new LiveUsageError(problems.join("\n"));
  return {
    auth: cli ? { kind: "cli" } : { kind: "apiKey", apiKey },
    rootfs,
    shape: env.SEALED_CREATEOS_SHAPE?.trim() || "s-1vcpu-1gb",
    egress,
    question: env.SEALED_LIVE_QUESTION?.trim() || DEFAULT_QUESTION,
    timeoutMs,
    reportPath: env.SEALED_LIVE_REPORT?.trim() || undefined,
  };
}

/** Structural subset of the SDK's `Sandbox` handle that cleanup needs. */
export interface SdkSandbox {
  id: string;
  name?: string;
  status: string;
  data: { forked_from?: string };
  files: CreateOSSandbox["files"];
  runCommand: CreateOSSandbox["runCommand"];
  pause(): Promise<unknown>;
  waitUntilPaused(options?: { timeoutMs?: number }): Promise<unknown>;
  fork(request: { ingress_enabled: false; egress: string[] }): Promise<SdkSandbox>;
  waitUntilRunning(options?: { timeoutMs?: number }): Promise<unknown>;
  destroy(): Promise<unknown>;
  waitUntilDestroyed(options?: { timeoutMs?: number }): Promise<unknown>;
  refresh(): Promise<unknown>;
  getEgress(): Promise<{ egress: string[] }>;
}

export interface SdkClient {
  createSandbox(request: {
    name: string;
    shape: string;
    rootfs: string;
    ingress_enabled: false;
    egress: string[];
  }): Promise<SdkSandbox>;
}

const WAIT = { timeoutMs: 120_000 };

/**
 * CreateOSClient for lib/sandbox's CreateOSRuntime that records every sandbox
 * this run creates (including forks) and names root VMs with a run prefix, so
 * cleanup can target exactly these resources.
 */
export class TrackingClient implements CreateOSClient {
  readonly created = new Map<string, SdkSandbox>();

  constructor(
    private sdk: SdkClient,
    readonly prefix: string,
    private log: (event: string, detail: unknown) => void
  ) {}

  async createSandbox(request: Parameters<CreateOSClient["createSandbox"]>[0]) {
    const name = `${this.prefix}-${this.created.size}`;
    const box = await this.sdk.createSandbox({ ...request, name });
    return this.track(box);
  }

  private track(box: SdkSandbox): CreateOSSandbox {
    this.created.set(box.id, box);
    this.log("sandbox_created", { id: box.id, status: box.status });
    return {
      id: box.id,
      files: box.files,
      runCommand: (cmd, args, options) => box.runCommand(cmd, args, options),
      pause: () => box.pause(),
      waitUntilPaused: () => box.waitUntilPaused(WAIT),
      fork: async (request) => this.track(await box.fork(request)),
      waitUntilRunning: () => box.waitUntilRunning(WAIT),
      destroy: () => box.destroy(),
      waitUntilDestroyed: () => box.waitUntilDestroyed(WAIT),
    };
  }
}

/**
 * Which sandboxes this run may destroy: those it tracked, plus listed ones
 * carrying its name prefix or forked from one of its sandboxes (covers a
 * create/fork that timed out before returning an ID). Anything that existed
 * before the run started is never included.
 */
export function planCleanup(input: {
  preexisting: ReadonlySet<string>;
  created: Iterable<string>;
  listing: Array<Pick<SdkSandbox, "id" | "name" | "data">>;
  prefix: string;
}): string[] {
  const ours = new Set(input.created);
  for (const box of input.listing) {
    const forkedFrom = box.data?.forked_from;
    if (box.name?.startsWith(`${input.prefix}-`) || (forkedFrom && ours.has(forkedFrom))) {
      ours.add(box.id);
    }
  }
  return [...ours].filter((id) => !input.preexisting.has(id));
}

/**
 * Reads the provider-side allowlist back and requires it to equal the
 * configured, non-empty rules. An empty list means "allow all" in CreateOS,
 * so this runs before the connection probe and before any upload.
 */
export async function assertEgressMatches(
  box: Pick<SdkSandbox, "getEgress"> | undefined,
  expected: string[]
): Promise<void> {
  if (!box) throw new Error("Sandbox was not created by this run");
  const { egress } = await box.getEgress();
  const actual = [...(egress ?? [])].sort();
  const wanted = [...expected].sort();
  if (actual.length === 0 || actual.length !== wanted.length || actual.some((rule, i) => rule !== wanted[i])) {
    throw new Error("Sandbox egress allowlist does not match the restrictive configuration");
  }
}

/**
 * Payment stand-in for this script only. It approves exactly one synthetic
 * session ID generated in-process and cannot create checkouts. It is not
 * exported from lib/agent and no route can reach it; the web app always uses
 * Stripe through lib/payments.
 */
export class SyntheticRunPayments implements PaymentProvider {
  private jobId?: string;

  constructor(readonly sessionId: string) {}

  bind(jobId: string) {
    this.jobId = jobId;
  }

  async createCheckout(): Promise<never> {
    throw new Error("Live smoke test never creates checkouts");
  }

  async verifyPayment(sessionId: string): Promise<PaymentVerification> {
    const paid = !!this.jobId && sessionId === this.sessionId;
    return { jobId: this.jobId ?? "", paid, stripeSessionId: sessionId };
  }
}
