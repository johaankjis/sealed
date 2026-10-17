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

  it("approves an empty result that carries empty group-size evidence", async () => {
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

  it("does not false-positive on benign column names", async () => {
    const decision = await policy.validate({
      columns: ["month_name", "product_name", "orders", "description"],
      rows: [{ month_name: "January", product_name: "Widget", orders: 5, description: "ok" }],
      groupSizes: [12],
    });
    expect(decision.approved).toBe(true);
  });
});

describe("AggregateOnlyOutputPolicy — fail-closed group-size evidence", () => {
  const rejected = async (result: unknown) => {
    const decision = await policy.validate(result as ExecutionResult);
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBeTruthy();
    expect(decision.result).toBeUndefined();
    return decision;
  };

  it("rejects results without groupSizes even when the row cap would hold", async () => {
    const decision = await rejected({
      columns: ["region", "revenue"],
      rows: [{ region: "EMEA", revenue: 100 }],
    });
    expect(decision.reason).toContain("fail closed");
  });

  it("rejects empty results without groupSizes (no fallback path)", async () => {
    await rejected({ columns: ["region", "revenue"], rows: [] });
  });

  it("rejects null groupSizes", async () => {
    await rejected({
      columns: ["region", "revenue"],
      rows: [{ region: "EMEA", revenue: 100 }],
      groupSizes: null,
    });
  });
});

describe("AggregateOnlyOutputPolicy — fabricated evidence", () => {
  const rejected = async (result: unknown, options = {}) => {
    const decision = await new AggregateOnlyOutputPolicy(options).validate(
      result as ExecutionResult
    );
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBeTruthy();
    return decision;
  };

  it("rejects groupSizes contradicted by a row-count column", async () => {
    const decision = await rejected({
      columns: ["region", "revenue", "record_count"],
      rows: [
        { region: "EMEA", revenue: 100, record_count: 10 },
        { region: "APAC", revenue: 50, record_count: 120 },
      ],
      groupSizes: [10, 10],
    });
    expect(decision.reason).toContain("conflicts with group-size evidence");
  });

  it("rejects a null count in a count column (cannot corroborate)", async () => {
    await rejected({
      columns: ["region", "count"],
      rows: [{ region: "EMEA", count: null }],
      groupSizes: [10],
    });
  });

  it("approves when a row-count column corroborates groupSizes", async () => {
    const decision = await policy.validate({
      columns: ["region", "revenue", "record_count"],
      rows: [
        { region: "EMEA", revenue: 100, record_count: 10 },
        { region: "APAC", revenue: 50, record_count: 25 },
      ],
      groupSizes: [10, 25],
    });
    expect(decision.approved).toBe(true);
  });

  it("rejects internally inconsistent groupSizes even with a permissive k", async () => {
    await rejected(
      {
        columns: ["region", "revenue"],
        rows: [
          { region: "EMEA", revenue: 1 },
          { region: "AMER", revenue: 2 },
          { region: "APAC", revenue: 3 },
        ],
        groupSizes: [0, 0, 0],
      },
      { minGroupSize: 0, rejectRowCapSaturation: false }
    );
  });
});

describe("AggregateOnlyOutputPolicy — single-customer aggregates", () => {
  const rejected = async (result: unknown) => {
    const decision = await policy.validate(result as ExecutionResult);
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBeTruthy();
    return decision;
  };

  it("rejects a group representing a single record", async () => {
    const decision = await rejected({
      columns: ["region", "revenue"],
      rows: [{ region: "EMEA", revenue: 500 }],
      groupSizes: [1],
    });
    expect(decision.reason).toContain("minimum group size");
  });

  it("rejects below-k groups that could isolate one customer", async () => {
    await rejected({
      columns: ["region", "revenue"],
      rows: [{ region: "EMEA", revenue: 500 }],
      groupSizes: [9],
    });
  });

  it("rejects per-customer dimensions regardless of claimed sizes", async () => {
    await rejected({
      columns: ["customer", "spend"],
      rows: [{ customer: "ACME Corp", spend: 5 }],
      groupSizes: [10],
    });
    await rejected({
      columns: ["account", "balance"],
      rows: [{ account: "ACC-1", balance: 5 }],
      groupSizes: [10],
    });
    await rejected({
      columns: ["first_name", "orders"],
      rows: [{ first_name: "J", orders: 5 }],
      groupSizes: [10],
    });
  });
});

describe("AggregateOnlyOutputPolicy — row-cap saturation", () => {
  it("rejects results that exactly fill the row cap (likely truncated dumps)", async () => {
    const rows = Array.from({ length: DEFAULT_OUTPUT_POLICY_OPTIONS.maxRows }, (_, i) => ({
      region: `R${i % 20}`,
      revenue: i,
    }));
    const decision = await policy.validate({
      columns: ["region", "revenue"],
      rows,
      groupSizes: rows.map(() => 10),
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain("row limit");
  });

  it("allows disabling saturation rejection via options", async () => {
    const lenient = new AggregateOnlyOutputPolicy({
      rejectRowCapSaturation: false,
      maxRows: 3,
    });
    const decision = await lenient.validate({
      columns: ["region", "revenue"],
      rows: [
        { region: "A", revenue: 1 },
        { region: "B", revenue: 2 },
        { region: "C", revenue: 3 },
      ],
      groupSizes: [10, 10, 10],
    });
    expect(decision.approved).toBe(true);
  });
});

describe("AggregateOnlyOutputPolicy — overlapping queries", () => {
  const validate = (p: AggregateOnlyOutputPolicy, dims: string[]) =>
    p.validate({
      columns: [...dims, "revenue"],
      rows: [
        {
          ...Object.fromEntries(dims.map((d, i) => [d, `v${i}`])),
          revenue: 100,
        },
      ],
      groupSizes: [10],
    });

  it("allows a base slice and rejects beyond the drill-down depth limit", async () => {
    const p = new AggregateOnlyOutputPolicy();

    expect((await validate(p, ["month"])).approved).toBe(true); // depth 0
    expect((await validate(p, ["month", "region"])).approved).toBe(true); // depth 1
    expect((await validate(p, ["month", "region", "age"])).approved).toBe(true); // depth 2

    const decision = await validate(p, ["month", "region", "age", "city"]);
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain("drill-down depth");
  });

  it("allows a single refinement when the depth limit is 0", async () => {
    const p = new AggregateOnlyOutputPolicy({ maxRefinementDepth: 0 });
    expect((await validate(p, ["month"])).approved).toBe(true);
    const decision = await validate(p, ["month", "region"]);
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain("drill-down depth");
  });

  it("treats independent dimension chains separately", async () => {
    const p = new AggregateOnlyOutputPolicy();
    expect((await validate(p, ["month"])).approved).toBe(true);
    expect((await validate(p, ["region"])).approved).toBe(true);
    expect((await validate(p, ["category"])).approved).toBe(true);
    // {month, region} refines {month} (depth 1) — still within the default limit.
    expect((await validate(p, ["month", "region"])).approved).toBe(true);
  });

  it("keeps the total-then-grouped happy path working", async () => {
    const p = new AggregateOnlyOutputPolicy();
    const total = await p.validate({
      columns: ["revenue"],
      rows: [{ revenue: 9900 }],
      groupSizes: [150],
    });
    expect(total.approved).toBe(true);
    expect((await validate(p, ["month"])).approved).toBe(true);
  });

  it("rejects same-column queries that narrow an approved slice", async () => {
    const p = new AggregateOnlyOutputPolicy();
    const broad = await p.validate({
      columns: ["region", "revenue"],
      rows: [
        { region: "EMEA", revenue: 100 },
        { region: "AMER", revenue: 90 },
        { region: "APAC", revenue: 80 },
        { region: "LATAM", revenue: 70 },
      ],
      groupSizes: [25, 25, 25, 25],
    });
    expect(broad.approved).toBe(true);

    const probe = await p.validate({
      columns: ["region", "revenue"],
      rows: [{ region: "EMEA", revenue: 100 }],
      groupSizes: [25],
    });
    expect(probe.approved).toBe(false);
    expect(probe.reason).toContain("narrows a previously approved slice");
  });

  it("allows repeats and disjoint slices, which carry no new intersection risk", async () => {
    const p = new AggregateOnlyOutputPolicy();
    const result = {
      columns: ["region", "revenue"],
      rows: [
        { region: "EMEA", revenue: 100 },
        { region: "AMER", revenue: 90 },
      ],
      groupSizes: [25, 25],
    };
    expect((await p.validate(result)).approved).toBe(true);
    expect((await p.validate(result)).approved).toBe(true); // idempotent re-fetch

    const disjoint = await p.validate({
      columns: ["region", "revenue"],
      rows: [{ region: "LUNA", revenue: 1 }],
      groupSizes: [10],
    });
    expect(disjoint.approved).toBe(true);
  });

  it("bounds its memory so history cannot grow without limit", async () => {
    const p = new AggregateOnlyOutputPolicy({ maxTrackedResults: 2 });
    await validate(p, ["region"]);
    await validate(p, ["category"]);
    await validate(p, ["day"]);
    // {region} history has been evicted; narrowing it is no longer detected.
    expect((await validate(p, ["region"])).approved).toBe(true);
  });

  it("ignores empty results for overlap purposes", async () => {
    const p = new AggregateOnlyOutputPolicy();
    expect(
      (
        await p.validate({
          columns: ["region", "revenue"],
          rows: [],
          groupSizes: [],
        })
      ).approved
    ).toBe(true);
    expect((await validate(p, ["region"])).approved).toBe(true);
  });
});

describe("AggregateOnlyOutputPolicy — structural rejections", () => {
  const rejected = async (result: unknown) => {
    const decision = await policy.validate(result as ExecutionResult);
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBeTruthy();
    expect(decision.result).toBeUndefined();
    return decision;
  };

  it("rejects missing or empty columns", async () => {
    await rejected({ columns: [], rows: [], groupSizes: [] });
    await rejected({ rows: [], groupSizes: [] });
  });

  it("rejects too many columns", async () => {
    const columns = Array.from(
      { length: DEFAULT_OUTPUT_POLICY_OPTIONS.maxColumns + 1 },
      (_, i) => `c${i}`
    );
    await rejected({ columns, rows: [], groupSizes: [] });
  });

  it("rejects duplicate column names", async () => {
    await rejected({ columns: ["month", "month"], rows: [], groupSizes: [] });
  });

  it("rejects sensitive columns by name", async () => {
    await rejected({
      columns: ["customer_email", "total"],
      rows: [{ customer_email: "x", total: 1 }],
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
    const rows = Array.from(
      { length: DEFAULT_OUTPUT_POLICY_OPTIONS.maxRows + 1 },
      () => ({ region: "EMEA", revenue: 1 })
    );
    await rejected({
      columns: ["region", "revenue"],
      rows,
      groupSizes: rows.map(() => 10),
    });
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
    await rejected({
      columns: ["region", "revenue"],
      rows: [{ region: "EMEA", revenue: 1 }],
      groupSizes: [-10],
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
