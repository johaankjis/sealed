import { describe, expect, it } from "vitest";
import type { SandboxRuntime } from "../../../contracts/sandbox";
import { SequentialSandboxRuntime } from "../sequentialSandbox";

function inner(log: string[], name: string, overrides: Partial<SandboxRuntime> = {}): SandboxRuntime {
  return {
    prepareDataset: async () => {
      log.push(`${name}:prepare`);
      return `h-${name}`;
    },
    execute: async () => {
      log.push(`${name}:execute`);
      return { columns: [], rows: [] };
    },
    destroy: async () => {
      log.push(`${name}:destroy`);
    },
    ...overrides,
  };
}

describe("SequentialSandboxRuntime", () => {
  it("runs whole lifecycles one after another with a fresh runtime each", async () => {
    const log: string[] = [];
    let n = 0;
    const seq = new SequentialSandboxRuntime(() => inner(log, String(++n)));
    const job = async () => {
      const h = await seq.prepareDataset("d", "p");
      await seq.execute(h, "code");
      await new Promise((r) => setTimeout(r, 5));
      await seq.destroy(h);
    };
    await Promise.all([job(), job()]);
    expect(log).toEqual(["1:prepare", "1:execute", "1:destroy", "2:prepare", "2:execute", "2:destroy"]);
  });

  it("releases the queue when prepare fails or destroy throws", async () => {
    const log: string[] = [];
    const runtimes = [
      inner(log, "a", { prepareDataset: async () => Promise.reject(new Error("prep")) }),
      inner(log, "b", { destroy: async () => Promise.reject(new Error("quarantined")) }),
      inner(log, "c"),
    ];
    const seq = new SequentialSandboxRuntime(() => runtimes.shift()!);
    await expect(seq.prepareDataset("d", "p")).rejects.toThrow("prep");
    const hb = await seq.prepareDataset("d", "p");
    await expect(seq.destroy(hb)).rejects.toThrow("quarantined");
    const hc = await seq.prepareDataset("d", "p");
    expect(hc).toBe("h-c");
  });

  it("gives up waiting after maxWaitMs and keeps the queue usable", async () => {
    const log: string[] = [];
    let n = 0;
    const seq = new SequentialSandboxRuntime(() => inner(log, String(++n)), 20);
    const held = await seq.prepareDataset("d", "p");
    await expect(seq.prepareDataset("d", "p")).rejects.toThrow("SANDBOX_QUEUE_TIMEOUT");
    await seq.destroy(held);
    await expect(seq.prepareDataset("d", "p")).resolves.toBe("h-2");
  });

  it("rejects unknown handles", async () => {
    const seq = new SequentialSandboxRuntime(() => inner([], "x"));
    await expect(seq.execute("nope", "code")).rejects.toThrow("SANDBOX_HANDLE_UNKNOWN");
    await expect(seq.destroy("nope")).resolves.toBeUndefined();
  });
});
