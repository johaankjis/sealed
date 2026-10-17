/** Opt-in, billable CreateOS integration test. Synthetic data only; no local Python execution.
 * Node 24: node --experimental-transform-types sandbox/live-smoke.ts --run --cli-auth
 * Set SEALED_CREATEOS_SDK_MODULE to an installed SDK import path if not in root deps.
 */
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateOSClient, CreateOSSandbox } from "../lib/sandbox/createos";

if (!process.argv.includes("--run")) throw new Error("Explicit --run required: creates paid test VMs");
const sdkModule = process.env.SEALED_CREATEOS_SDK_MODULE ?? "@nodeops-createos/sandbox";
const { createClient } = await import(sdkModule);
const { CreateOSRuntime } = await import(new URL("../lib/sandbox/createos.ts", import.meta.url).href);
let authHeaders: Record<string, string> | undefined;
if (process.argv.includes("--cli-auth")) {
  const oauth = JSON.parse(await readFile(join(homedir(), ".createos/.oauth"), "utf8"));
  authHeaders = { "X-Access-Token": oauth.access_token };
}
const client = createClient({ authHeaders, retry: false, timeoutMs: 60_000 });
// SDK objects are dynamically imported so this opt-in script adds no root dependency.
const boxes = new Map<string, any>();
const events: unknown[] = [];
function record(event: string, detail: unknown) {
  events.push({ event, detail });
  console.log(JSON.stringify({ event, detail }));
}
function wrap(box: any): CreateOSSandbox {
  boxes.set(box.id, box);
  record("tracked", { id: box.id, status: box.status });
  return {
    id: box.id, files: box.files,
    runCommand: async (cmd, args, options) => {
      const start = Date.now();
      const response = await box.runCommand(cmd, args, options);
      record("command", { id: box.id, exit: response.result.exit_code, elapsedMs: Date.now() - start });
      return response;
    },
    pause: async () => {
      // Validate the protocol independently so snapshot failures cannot hide runner regressions.
      await box.files.upload("/tmp/sealed-analysis.py", code);
      const valid = await box.runCommand("timeout", ["--foreground", "--signal=KILL", "2s", "python3", "-I", "/tmp/sealed-runner.py"],
        { timeoutMs: 7000, retry: false });
      assert.equal(valid.result.exit_code, 0);
      const candidate = JSON.parse(valid.result.stdout);
      assert.deepEqual(candidate.rows.map((row: any) => row.avg).sort((a: number, b: number) => a - b), [12.5, 20]);
      record("printed_json_runner_passed", candidate);
      await box.files.upload("/tmp/sealed-analysis.py", 'result = {"columns":["n"],"rows":[{"n":20}],"groupSizes":[20]}');
      const legacy = await box.runCommand("python3", ["-I", "/tmp/sealed-runner.py"], { timeoutMs: 7000, retry: false });
      assert.equal(legacy.result.exit_code, 0);
      assert.equal(JSON.parse(legacy.result.stdout).rows[0].n, 20);
      record("assignment_runner_passed", {});
      const parquet = await box.runCommand("python3", ["-c",
        "import duckdb,os,json; c=duckdb.connect(); c.execute(\"COPY (SELECT * FROM read_csv_auto('/tmp/sealed-dataset')) TO '/tmp/sealed-data.parquet' (FORMAT PARQUET)\"); os.rename('/tmp/sealed-dataset','/tmp/sealed-data.csv'); os.rename('/tmp/sealed-data.parquet','/tmp/sealed-dataset'); json.dump({'tableName':'orders','format':'parquet'},open('/tmp/sealed-dataset.json','w'))"],
        { timeoutMs: 7000, retry: false });
      assert.equal(parquet.result.exit_code, 0);
      await box.files.upload("/tmp/sealed-analysis.py", code);
      const parquetResult = await box.runCommand("python3", ["-I", "/tmp/sealed-runner.py"], { timeoutMs: 7000, retry: false });
      assert.equal(parquetResult.result.exit_code, 0);
      assert.deepEqual(JSON.parse(parquetResult.result.stdout), candidate);
      record("parquet_runner_passed", {});
      for (const invalid of ['print("not json")', 'print("debug")\n' + code,
        'raise ValueError("SYNTHETIC_DIAGNOSTIC")', 'print("x" * 1000001)']) {
        await box.files.upload("/tmp/sealed-analysis.py", invalid);
        const failed = await box.runCommand("timeout", ["--foreground", "--signal=KILL", "2s", "python3", "-I", "/tmp/sealed-runner.py"],
          { timeoutMs: 7000, retry: false });
        assert.notEqual(failed.result.exit_code, 0);
        assert.equal(failed.result.stdout, "");
        assert.equal(failed.result.stderr, "");
      }
      record("invalid_output_runner_passed", { cases: 4 });
      await box.files.upload("/tmp/sealed-analysis.py", "while True: pass");
      const start = Date.now();
      const timed = await box.runCommand("timeout", ["--foreground", "--signal=KILL", "2s", "python3", "-I", "/tmp/sealed-runner.py"],
        { timeoutMs: 7000, retry: false });
      record("guest_timeout_observed", { exit: timed.result.exit_code, error: timed.result.error,
        elapsedMs: Date.now() - start });
      assert.ok([124, 137].includes(timed.result.exit_code));
      record("guest_timeout_passed", { exit: timed.result.exit_code, elapsedMs: Date.now() - start });
      try { const result = await box.pause(); record("pause", { id: box.id, status: box.status }); return result; }
      catch (error: any) { record("pause_failed", { id: box.id, kind: error.name, status: error.statusCode, code: error.code }); throw error; }
    },
    waitUntilPaused: async () => {
      await box.waitUntilPaused({ timeoutMs: 60_000 });
      record("paused", { id: box.id, status: box.status });
    },
    fork: async request => {
      try { const child = await box.fork(request); record("fork", { parent: box.id, child: child.id }); return wrap(child); }
      catch (error: any) { record("fork_failed", { id: box.id, kind: error.name, status: error.statusCode, code: error.code }); throw error; }
    },
    waitUntilRunning: async () => {
      await box.waitUntilRunning({ timeoutMs: 60_000 });
      record("running", { id: box.id, status: box.status });
    },
    destroy: () => box.destroy(),
    waitUntilDestroyed: async () => {
      await box.waitUntilDestroyed({ timeoutMs: 60_000 });
      record("destroyed", { id: box.id, status: box.status });
    },
  };
}

const adapter: CreateOSClient = {
  async createSandbox(request) {
    // Bootstrap a dedicated test VM before uploading any dataset or generated code.
    let box: any;
    try {
      box = await client.createSandbox({ ...request, name: `sealed-${Date.now()}`,
        egress: ["pypi.org:443", "files.pythonhosted.org:443"] });
    } catch (error: any) {
      record("create_failed", { kind: error.name, status: error.statusCode, code: error.code,
        message: error.message }); // Synthetic provisioning request; no dataset/code supplied yet.
      throw error;
    }
    const wrapped = wrap(box);
    const install = await box.runCommand("python3", ["-m", "pip", "install", "duckdb==1.5.4"],
      { timeoutMs: 120_000, retry: false });
    assert.equal(install.result.exit_code, 0, "remote DuckDB bootstrap failed");
    const version = await box.runCommand("python3", ["-c", "import duckdb,sys; print(sys.version.split()[0], duckdb.__version__)"],
      { timeoutMs: 10_000, retry: false });
    record("remote_versions", version.result.stdout.trim());
    await box.setEgress(request.egress);
    return wrapped;
  },
};

const dir = await mkdtemp(join(tmpdir(), "sealed-live-"));
const fixture = await readFile(new URL("../lib/agent/__tests__/fakes.ts", import.meta.url), "utf8");
// Exercise the orchestration owner's exact Python fixture without importing its fakes.
const code = fixture.match(/export const safeCode = `([\s\S]*?)`;/)?.[1];
assert.ok(code, "agent fixture unavailable");
const dataset = "region,amount\n" + "EU,12.5\n".repeat(10) + "US,20\n".repeat(10);
await writeFile(join(dir, "orders.csv"), dataset);
const runtime = new CreateOSRuntime({ client: adapter, shape: "s-1vcpu-1gb", rootfs: "devbox:1",
  egress: ["127.0.0.1:9"], resolveTableName: () => "orders",
  // This explicitly authorized synthetic test is not a marketplace query.
  authorizeExecution: async () => true,
  verifyIsolation: async (box: CreateOSSandbox) => {
    const policy = await boxes.get(box.id).getEgress();
    assert.deepEqual(policy.egress, ["127.0.0.1:9"]);
    // Configuration readback only; not proof of network isolation.
  }, options: { timeoutMs: 2000, maxRetries: 0 } });

try {
  const snapshot = await runtime.prepareDataset("retail", join(dir, "orders.csv"));
  const result = await runtime.execute(snapshot, code);
  assert.deepEqual([...result.rows].sort((a, b) => String(a.region).localeCompare(String(b.region))), [
    { region: "EU", n: 10, avg: 12.5 }, { region: "US", n: 10, avg: 20 },
  ]);
  assert.deepEqual(result.groupSizes, [10, 10]);
  record("agent_python_passed", result);
  await assert.rejects(runtime.execute(snapshot, "while True: pass"), /SANDBOX_TIMEOUT/);
  record("timeout_passed", { budgetMs: 2000 });
  const pending = runtime.execute(snapshot, "while True: pass");
  const rejection = assert.rejects(pending, /SANDBOX_TIMEOUT/);
  // Simulates an outer caller abandoning its execution promise.
  await runtime.destroy(snapshot);
  await rejection;
  record("concurrent_cleanup_passed", { snapshot });
} catch (error: any) {
  record("test_failed", { kind: error.name, code: error.code ?? "LIVE_TEST_FAILED" });
  process.exitCode = 1;
} finally {
  try { await runtime.dispose(); } catch { record("runtime_cleanup_failed", {}); process.exitCode = 1; }
  for (const [id, box] of boxes) {
    try {
      await box.refresh();
      if (box.status !== "destroyed") { await box.destroy(); await box.waitUntilDestroyed({ timeoutMs: 60_000 }); }
      record("final_status", { id, status: box.status });
    } catch { record("cleanup_failed", { id }); process.exitCode = 1; }
  }
  await rm(dir, { recursive: true, force: true });
  if (process.env.SEALED_SMOKE_REPORT) {
    await writeFile(process.env.SEALED_SMOKE_REPORT, JSON.stringify(events, null, 2) + "\n");
  }
}
