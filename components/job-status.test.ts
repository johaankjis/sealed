import { describe, expect, it } from "vitest";
import type { JobStatus } from "../contracts/job";
import { isTerminalStatus, statusLabel } from "./job-status";
import { formatPrice, getDemoDataset } from "./datasets";

describe("statusLabel", () => {
  it("labels every JobStatus without falling back to the raw key", () => {
    const statuses: JobStatus[] = [
      "created",
      "payment_pending",
      "paid",
      "running",
      "validating",
      "completed",
      "rejected",
      "payment_failed",
      "execution_failed",
    ];
    for (const s of statuses) {
      expect(statusLabel(s)).not.toBe(s);
      expect(statusLabel(s).length).toBeGreaterThan(0);
    }
  });
});

describe("isTerminalStatus", () => {
  it("treats completed and failure states as terminal", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("rejected")).toBe(true);
    expect(isTerminalStatus("payment_failed")).toBe(true);
    expect(isTerminalStatus("execution_failed")).toBe(true);
  });

  it("keeps live states non-terminal so the tracker keeps polling", () => {
    expect(isTerminalStatus("created")).toBe(false);
    expect(isTerminalStatus("payment_pending")).toBe(false);
    expect(isTerminalStatus("paid")).toBe(false);
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus("validating")).toBe(false);
  });
});

describe("datasets fixtures", () => {
  it("resolves every fixture id and formats prices", () => {
    expect(getDemoDataset("downtown-coffee-sales")?.name).toBe("Downtown Coffee Sales");
    expect(getDemoDataset("missing")).toBeUndefined();
    expect(formatPrice(900)).toBe("$9");
    expect(formatPrice(1250)).toBe("$12.50");
  });
});
