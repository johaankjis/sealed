import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SandboxRuntime } from "../../contracts/sandbox";
import { SandboxError, parseExecutionResult } from "./createos";

export const SHARED_SANDBOX_ID = "sb-01m563ts9ekxrv0q85yptqsrh7";
const account = "75ea01ff-cb7f-4ed2-83c1-825a842c3673";
const request = { timeoutMs: 15_000, retry: false as const };
const leases = new Set<string>();
interface AttachedSandbox {
  id: string;
  data: { status: string; ingress_enabled?: boolean; created_by?: string };
  getEgress(options: typeof request): Promise<{ egress?: string[] }>;
  files: { upload(path: string, data: string | ArrayBuffer, options: typeof request): Promise<unknown> };
  runCommand(cmd: string, args: string[], options: typeof request): Promise<{
    result: { stdout: string; stderr: string; exit_code: number; error?: string };
  }>;
}
export interface SingleSandboxConfig {
  client: { getSandbox(id: string, options: typeof request): Promise<AttachedSandbox> };
  /** Server-maintained SHA256 allowlist of reviewed synthetic fixtures, never buyer input. */
  syntheticDatasets: Record<string, { sha256: string; tableName: string }>;
  authorizeExecution(jobHandle: string): Promise<boolean>;
  timeoutMs?: number;
}
/** Temporary synthetic-only mode. A lease spans prepare -> destroy; busy jobs fail closed. */
export class SingleSandboxRuntime implements SandboxRuntime {
  private box?: AttachedSandbox;
  private handle?: string;
  private directory?: string;
  private uncertain = false;
  private active?: Promise<unknown>;
  private used = false;
  private readonly timeoutMs: number;
  constructor(private readonly config: SingleSandboxConfig) {
    this.timeoutMs = config.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 120_000)
      throw new SandboxError("INVALID_SANDBOX_CONFIG");
  }
  private async command(code: string, args: string[] = [], timeoutMs = 15_000) {
    return (await this.box!.runCommand("python3", ["-I", "-c", code, ...args], { timeoutMs, retry: false })).result;
  }
  private async isolation() {
    const box = await this.config.client.getSandbox(SHARED_SANDBOX_ID, request);
    if (box.id !== SHARED_SANDBOX_ID || box.data.status !== "running" ||
        box.data.ingress_enabled !== false || box.data.created_by !== account)
      throw new SandboxError("SHARED_ATTACHMENT_REJECTED");
    this.box = box;
    const policy = await box.getEgress(request);
    // No wildcard, arbitrary deployment allowlist, or empty (allow-all) policy accepted.
    if (JSON.stringify(policy.egress) !== JSON.stringify(["127.0.0.1:9"]))
      throw new SandboxError("SHARED_EGRESS_UNVERIFIED");
    const probe = await readFile(new URL("../../sandbox/shared-probe.py", import.meta.url), "utf8");
    const result = await this.command(probe);
    if (result.exit_code !== 0 || result.error || result.stdout.trim() !== "BLOCKED")
      throw new SandboxError("SHARED_EGRESS_UNVERIFIED");
  }
  async prepareDataset(datasetId: string, datasetPath: string): Promise<string> {
    if (leases.has(SHARED_SANDBOX_ID)) throw new SandboxError("SHARED_SANDBOX_BUSY");
    leases.add(SHARED_SANDBOX_ID);
    try {
      const fixture = this.config.syntheticDatasets[datasetId];
      const data = await readFile(datasetPath);
      if (!fixture || !datasetPath.endsWith(".csv") || data.length > 50_000_000 ||
          createHash("sha256").update(data).digest("hex") !== fixture.sha256 ||
          !fixture.tableName || fixture.tableName.includes("\0")) throw new SandboxError("SYNTHETIC_DATA_REQUIRED");
      await this.isolation();
      const handle = randomUUID();
      const directory = `/tmp/sealed-shared-${handle}`;
      // mkdir is an atomic cross-process lease. Never steal an existing lease.
      this.uncertain = true;
      const lock = await this.command("import os,sys\nos.mkdir('/tmp/sealed-shared.lock',0o700)\nos.mkdir(sys.argv[1],0o700)", [directory]);
      if (lock.exit_code !== 0 || lock.error) throw new SandboxError("SHARED_LEASE_UNAVAILABLE");
      this.handle = handle; this.directory = directory; this.uncertain = false; this.used = false;
      const runner = 'import sys\nsys.path.append("/root/.local/lib/python3.13/site-packages")\n' + (await readFile(new URL("../../sandbox/runner.py", import.meta.url), "utf8"))
        .replaceAll("/tmp/sealed-", `${directory}/sealed-`);
      this.uncertain = true;
      await this.box!.files.upload(`${directory}/sealed-dataset`, Uint8Array.from(data).buffer, request);
      await this.box!.files.upload(`${directory}/sealed-dataset.json`, JSON.stringify({ tableName: fixture.tableName, format: "csv" }), request);
      await this.box!.files.upload(`${directory}/sealed-runner.py`, runner, request);
      this.uncertain = false;
      return handle;
    } catch (error) {
      if (this.handle) await this.destroy(this.handle);
      else if (!this.uncertain) leases.delete(SHARED_SANDBOX_ID);
      if (error instanceof SandboxError) throw error;
      throw new SandboxError("SHARED_PREPARATION_FAILED");
    }
  }
  async execute(handle: string, code: string) {
    if (handle !== this.handle || this.active || this.used || this.uncertain)
      throw new SandboxError("SHARED_JOB_UNAVAILABLE");
    if (!code.trim() || Buffer.byteLength(code) > 64_000) throw new SandboxError("INVALID_CODE");
    this.used = true;
    const execution = this.run(handle, code);
    this.active = execution;
    try { return await execution; } finally { this.active = undefined; }
  }
  private async run(handle: string, code: string) {
    try {
      if (!await this.config.authorizeExecution(handle)) throw new SandboxError("PAYMENT_REQUIRED");
      await this.isolation();
      this.uncertain = true;
      await this.box!.files.upload(`${this.directory}/sealed-analysis.py`, code, request);
      this.uncertain = false;
      const supervisor = await readFile(new URL("../../sandbox/shared-supervisor.py", import.meta.url), "utf8");
      this.uncertain = true;
      const result = await this.command(supervisor, [this.directory!, String(this.timeoutMs / 1000)], this.timeoutMs + 10_000);
      // Only trusted supervisor completion acknowledges that process-group cleanup ran.
      if (![0, 1, 124].includes(result.exit_code) || result.error) throw new SandboxError("SHARED_EXECUTION_UNCERTAIN");
      this.uncertain = false;
      if (result.exit_code === 124) throw new SandboxError("SANDBOX_TIMEOUT");
      if (result.exit_code !== 0) throw new SandboxError("SANDBOX_EXECUTION_FAILED");
      return parseExecutionResult(result.stdout);
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      throw new SandboxError("SHARED_EXECUTION_FAILED");
    } finally {
      if (!this.uncertain) await this.cleanup();
    }
  }
  private async cleanup() {
    if (!this.directory) return;
    this.uncertain = true;
    try {
      const result = await this.command("import shutil,os,sys\nshutil.rmtree(sys.argv[1])\nos.rmdir('/tmp/sealed-shared.lock')", [this.directory]);
      if (result.exit_code !== 0 || result.error) throw new SandboxError("SHARED_CLEANUP_FAILED");
    } catch { throw new SandboxError("SHARED_CLEANUP_FAILED"); }
    this.directory = undefined; this.handle = undefined; this.uncertain = false;
    leases.delete(SHARED_SANDBOX_ID);
  }
  async destroy(handle: string): Promise<void> {
    if (this.active) await this.active.catch(() => {});
    if (this.uncertain) throw new SandboxError("SHARED_RECONCILIATION_REQUIRED");
    if (handle === this.handle) await this.cleanup();
  }
}

/** Explicit opt-in for the composition owner; default snapshot/fork wiring is unchanged. */
export function singleSandboxFromEnv(config: SingleSandboxConfig, env: NodeJS.ProcessEnv = process.env) {
  if (env.SEALED_SANDBOX_MODE !== "single-synthetic" || env.SEALED_SHARED_SANDBOX_ID !== SHARED_SANDBOX_ID)
    throw new SandboxError("SHARED_MODE_NOT_ENABLED");
  return new SingleSandboxRuntime(config);
}
