import { describe, expect, it } from "vitest";

import {
  AggregateOnlyOutputPolicy,
  DEFAULT_OUTPUT_POLICY_OPTIONS,
} from "../output-policy";
import type { ExecutionResult } from "../../../contracts/results";

const policy = new AggregateOnlyOutputPolicy();

function aggregate(): ExecutionResult {
  return {
    columns: ["month", "total_sales"],
    rows: [
      { month: "2026-01", total_sales: 1520 },
      { month: "2026-02", total_sales: 1830 },
    ],
    groupSizes: [42, 57],
  };
}

describe("AggregateOnlyOutputPolicy — approvals", () => {
  it("approves a clean aggregate and builds an ApprovedResult", async () => {
    const decision = await policy.validate(aggregate());

    expect(decision.approved).toBe(true);
    expect(decision.result).toEqual({
      summary: "Aggregated result with 2 row(s) across 2 column(s).",
      columns: ["month", "total_sales"],
      rows: aggregate().rows,
      chartType: "line", // month labels are temporal
    });
  });

  it("picks bar for categorical labels", async () => {
    const decision = await policy.validate({
      columns: ["region", "revenue"],
      rows: [{ region: "EMEA", revenue: 100 }],
      groupSizes: [25],
    });
    expect(decision.result?.chartType).toBe("bar");
  });

  it("approves a result with no group metadata (row cap is the backstop)", async () => {
    const decision = await policy.validate({
      columns: ["region", "revenue"],
      rows: [{ region: "EMEA", revenue: 100 }],
    });
    expect(decision.approved).toBe(true);
  });

  it("approves an empty result with chartType none", async () => {
    const decision = await policy.validate({
      columns: ["month", "total_sales"],
      rows: [],
      groupSizes: [],
    });
    expect(decision.approved).toBe(true);
    expect(decision.result?.chartType).toBe("none");
  });

  it("picks line for temporal labels and none for multi-measure tables", async () => {
    const line = await policy.validate({
      columns: ["day", "signups"],
      rows: [
        { day: "2026-01-01", signups: 12 },
        { day: "2026-01-02", signups: 30 },
      ],
      groupSizes: [11, 13],
    });
    expect(line.result?.chartType).toBe("line");

    const none = await policy.validate({
      columns: ["region", "revenue", "orders"],
      rows: [{ region: "EMEA", revenue: 100, orders: 7 }],
      groupSizes: [25],
    });
    expect(none.result?.chartType).toBe("none");
  });
});

describe("AggregateOnlyOutputPolicy — rejections", () => {
  const rejected = async (result: unknown) => {
    const decision = await policy.validate(result as ExecutionResult);
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBeTruthy();
    expect(decision.result).toBeUndefined();
    return decision;
  };

  it("rejects missing or empty columns", async () => {
    await rejected({ columns: [], rows: [] });
    await rejected({ rows: [] });
  });

  it("rejects too many columns", async () => {
    const columns = Array.from(
      { length: DEFAULT_OUTPUT_POLICY_OPTIONS.maxColumns + 1 },
      (_, i) => `c${i}`
    );
    await rejected({ columns, rows: [] });
  });

  it("rejects duplicate column names", async () => {
    // Column checks run before row checks, so rows can be empty here.
    await rejected({ columns: ["month", "month"], rows: [] });
  });

  it("rejects sensitive columns by name", async () => {
    await rejected({
      columns: ["customer_email", "count"],
      rows: [{ customer_email: "x", count: 1 }],
      groupSizes: [10],
    });
  });

  it("rejects identifier columns used as dimensions", async () => {
    await rejected({
      columns: ["customer_id", "spend"],
      rows: [{ customer_id: "C1", spend: 5 }],
      groupSizes: [10],
    });
  });

  it("rejects raw dumps exceeding the row cap", async () => {
    const rows = Array.from({ length: DEFAULT_OUTPUT_POLICY_OPTIONS.maxRows + 1 }, () => ({
      region: "EMEA",
      revenue: 1,
    }));
    await rejected({ columns: ["region", "revenue"], rows });
  });

  it("rejects rows that do not match the column set", async () => {
    await rejected({
      columns: ["a", "b"],
      rows: [{ a: 1 }],
      groupSizes: [10],
    });
    await rejected({
      columns: ["a"],
      rows: [{ a: 1, b: 2 }],
      groupSizes: [10],
    });
  });

  it("rejects unsupported cell types", async () => {
    await rejected({
      columns: ["a"],
      rows: [{ a: true }],
      groupSizes: [10],
    });
    await rejected({
      columns: ["a"],
      rows: [{ a: Number.NaN }],
      groupSizes: [10],
    });
  });

  it("rejects oversized string cells", async () => {
    await rejected({
      columns: ["note"],
      rows: [{ note: "x".repeat(DEFAULT_OUTPUT_POLICY_OPTIONS.maxCellLength + 1) }],
      groupSizes: [10],
    });
  });

  it("rejects control characters and email-shaped values in cells", async () => {
    await rejected({
      columns: ["note"],
      rows: [{ note: "bad\u0000value" }],
      groupSizes: [10],
    });
    await rejected({
      columns: ["note"],
      rows: [{ note: "reach me at bob@corp.com" }],
      groupSizes: [10],
    });
  });

  it("rejects groups below the minimum group size", async () => {
    const decision = await rejected({
      columns: ["region", "revenue"],
      rows: [{ region: "TINY", revenue: 10 }],
      groupSizes: [3],
    });
    expect(decision.reason).toContain("minimum group size");
  });

  it("rejects malformed groupSizes", async () => {
    await rejected({
      columns: ["region", "revenue"],
      rows: [{ region: "EMEA", revenue: 1 }],
      groupSizes: [10, 12],
    });
    await rejected({
      columns: ["region", "revenue"],
      rows: [{ region: "EMEA", revenue: 1 }],
      groupSizes: [10.5],
    });
  });
});

describe("AggregateOnlyOutputPolicy — configuration", () => {
  it("honors a custom minimum group size", async () => {
    const strict = new AggregateOnlyOutputPolicy({ minGroupSize: 100 });
    const decision = await strict.validate({
      columns: ["region", "revenue"],
      rows: [{ region: "EMEA", revenue: 10 }],
      groupSizes: [42],
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain("100");
  });

  it("reports validation failures as decisions, never throws", async () => {
    const decision = await policy.validate(undefined as unknown as ExecutionResult);
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBeTruthy();
  });
});
