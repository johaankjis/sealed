import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertEgressMatches,
  LiveUsageError,
  parseLiveConfig,
  planCleanup,
  SyntheticRunPayments,
  TrackingClient,
  type SdkClient,
  type SdkSandbox,
} from "../live/support";

// These tests never execute coffee-live.ts and never contact CreateOS.

const ROOT = join(__dirname, "../../..");

const validEnv = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  CREATEOS_SANDBOX_API_KEY: "sb-test",
  SEALED_CREATEOS_ROOTFS: "sealed-duckdb",
  SEALED_CREATEOS_EGRESS: "127.0.0.1:9",
};

describe("parseLiveConfig", () => {
  it("refuses to start without --run", () => {
    expect(() => parseLiveConfig([], validEnv)).toThrow(LiveUsageError);
    expect(() => parseLiveConfig(["--cli-auth"], validEnv)).toThrow("--run");
  });

  it("lists every missing setting without echoing values", () => {
    try {
      parseLiveConfig(["--run"], {});
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      for (const name of ["CREATEOS_SANDBOX_API_KEY", "ANTHROPIC_API_KEY", "SEALED_CREATEOS_ROOTFS", "SEALED_CREATEOS_EGRESS"]) {
        expect(message).toContain(name);
      }
    }
    try {
      parseLiveConfig(["--run"], { ...validEnv, SEALED_CREATEOS_EGRESS: "*" });
    } catch (err) {
      expect((err as Error).message).not.toContain("sk-ant-test");
    }
  });

  it.each([
    [{ SEALED_CREATEOS_EGRESS: "*" }, "must not allow everything"],
    [{ SEALED_CREATEOS_EGRESS: " , " }, "at least one rule"],
    [{ SEALED_CREATEOS_EGRESS: "1.1.1.1:443" }, "probe host"],
    [{ SEALED_DATA_DIR: "/tmp/real-data" }, "SEALED_DATA_DIR must be unset"],
    [{ SEALED_LIVE_TIMEOUT_MS: "500" }, "SEALED_LIVE_TIMEOUT_MS"],
  ])("rejects unsafe setting %o", (override, message) => {
    expect(() => parseLiveConfig(["--run"], { ...validEnv, ...override })).toThrow(message);
  });

  it("accepts CLI auth without an API key and applies defaults", () => {
    const { CREATEOS_SANDBOX_API_KEY: _omit, ...env } = validEnv;
    const config = parseLiveConfig(["--run", "--cli-auth"], env);
    expect(config.auth).toEqual({ kind: "cli" });
    expect(config.shape).toBe("s-1vcpu-1gb");
    expect(config.timeoutMs).toBe(30_000);
    expect(config.egress).toEqual(["127.0.0.1:9"]);
  });
});

function fakeBox(id: string, extra: Partial<SdkSandbox> = {}): SdkSandbox {
  const box: SdkSandbox = {
    id,
    status: "running",
    data: {},
    files: { upload: async () => undefined },
    runCommand: async () => ({ result: { stdout: "", stderr: "", exit_code: 0 } }),
    pause: async () => undefined,
    waitUntilPaused: async () => undefined,
    fork: async () => fakeBox(`${id}-fork`, { data: { forked_from: id } }),
    waitUntilRunning: async () => undefined,
    destroy: async () => undefined,
    waitUntilDestroyed: async () => undefined,
    refresh: async () => undefined,
    getEgress: async () => ({ egress: ["127.0.0.1:9"] }),
    ...extra,
  };
  return box;
}

describe("TrackingClient", () => {
  it("names root sandboxes with the run prefix and tracks forks", async () => {
    const requests: Array<Parameters<SdkClient["createSandbox"]>[0]> = [];
    const sdk: SdkClient = {
      createSandbox: async (request) => {
        requests.push(request);
        return fakeBox("sb-root");
      },
    };
    const tracking = new TrackingClient(sdk, "sl-1a2b3c4d", () => {});
    const root = await tracking.createSandbox({ shape: "s", rootfs: "t", ingress_enabled: false, egress: ["127.0.0.1:9"] });
    await root.fork({ ingress_enabled: false, egress: ["127.0.0.1:9"] });

    expect(requests[0].name).toBe("sl-1a2b3c4d-0");
    expect(requests[0].name.length).toBeLessThanOrEqual(22);
    expect(requests[0].egress).toEqual(["127.0.0.1:9"]);
    expect([...tracking.created.keys()]).toEqual(["sb-root", "sb-root-fork"]);
  });
});

describe("planCleanup", () => {
  const prefix = "sl-1a2b3c4d";

  it("never targets sandboxes that existed before the run", () => {
    const ids = planCleanup({
      preexisting: new Set(["sb-sealed-test", "sb-collision"]),
      created: ["sb-a", "sb-collision"],
      listing: [
        { id: "sb-sealed-test", name: "sealed-test", data: {} },
        { id: "sb-collision", name: `${prefix}-9`, data: {} },
      ],
      prefix,
    });
    expect(ids).toEqual(["sb-a"]);
  });

  it("includes untracked orphans carrying the prefix and forks of our sandboxes", () => {
    const ids = planCleanup({
      preexisting: new Set(["sb-other"]),
      created: ["sb-root"],
      listing: [
        { id: "sb-orphan", name: `${prefix}-1`, data: {} },
        { id: "sb-child", name: undefined, data: { forked_from: "sb-root" } },
        { id: "sb-unrelated", name: "sl-ffffffff-0", data: {} },
        { id: "sb-other-child", name: undefined, data: { forked_from: "sb-other" } },
      ],
      prefix,
    });
    expect(ids.sort()).toEqual(["sb-child", "sb-orphan", "sb-root"]);
  });
});

describe("assertEgressMatches", () => {
  const box = (egress: string[]) => ({ getEgress: async () => ({ egress }) });

  it("accepts the exact configured allowlist", async () => {
    await expect(assertEgressMatches(box(["127.0.0.1:9"]), ["127.0.0.1:9"])).resolves.toBeUndefined();
  });

  it.each([
    [[], "empty list means allow-all"],
    [["127.0.0.1:9", "pypi.org:443"], "extra rule"],
    [["pypi.org:443"], "different rule"],
  ])("rejects %o (%s)", async (egress) => {
    await expect(assertEgressMatches(box(egress), ["127.0.0.1:9"])).rejects.toThrow("does not match");
  });

  it("rejects sandboxes this run did not create", async () => {
    await expect(assertEgressMatches(undefined, ["127.0.0.1:9"])).rejects.toThrow("not created by this run");
  });
});

describe("SyntheticRunPayments", () => {
  it("approves only its own session after binding and cannot create checkouts", async () => {
    const payments = new SyntheticRunPayments("live_synthetic_1a2b3c4d");
    expect((await payments.verifyPayment("live_synthetic_1a2b3c4d")).paid).toBe(false);
    payments.bind("job-1");
    expect(await payments.verifyPayment("live_synthetic_1a2b3c4d")).toEqual({
      jobId: "job-1",
      paid: true,
      stripeSessionId: "live_synthetic_1a2b3c4d",
    });
    expect((await payments.verifyPayment("cs_test_other")).paid).toBe(false);
    await expect(payments.createCheckout()).rejects.toThrow();
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("live smoke isolation", () => {
  it("is not imported by the app, routes, or other modules", () => {
    const offenders = [...sourceFiles(join(ROOT, "app")), ...sourceFiles(join(ROOT, "lib")), ...sourceFiles(join(ROOT, "components"))]
      .filter((file) => !relative(ROOT, file).startsWith("lib/agent/live/"))
      .filter((file) => !file.endsWith("live.test.ts"))
      .filter((file) => /from\s+["'][^"']*\/live(\/|["'])|import\(["'][^"']*\/live(\/|["'])/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("validates flags before loading the SDK or creating anything", () => {
    const source = readFileSync(join(ROOT, "lib/agent/live/coffee-live.ts"), "utf8");
    const guard = source.indexOf("support.parseLiveConfig(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(source.indexOf('import("@nodeops-createos/sandbox")'));
    expect(source.indexOf("client.templates.list()")).toBeLessThan(source.indexOf("new CreateOSRuntime("));
    expect(source.indexOf("client.listSandboxes()")).toBeLessThan(source.indexOf("new CreateOSRuntime("));
    // Allowlist readback precedes the network probe; only approved results are reported.
    expect(source.indexOf("assertEgressMatches(")).toBeLessThan(source.indexOf("await verifyEgressBlocked(box)"));
    expect(source).toContain('done.status === "completed" && done.result ? { approvedResult');
    expect(source).toContain("maxRetries: 0");
  });
});
