import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEMO_DATASETS } from "../../../components/datasets";
import { COFFEE_DATASET, SYNTHETIC_DATASET_REGISTRY } from "../catalog";
import { generateCoffeeCsv } from "../demo/coffee";

describe("coffee demo dataset", () => {
  const csv = readFileSync(COFFEE_DATASET.path, "utf8");

  it("matches the deterministic generator", () => {
    expect(csv).toBe(generateCoffeeCsv());
  });

  it("matches the catalog's row count and columns", () => {
    const lines = csv.trim().split("\n");
    expect(lines.length - 1).toBe(COFFEE_DATASET.rowCount);
    expect(lines[0].split(",")).toEqual(COFFEE_DATASET.columns.map((c) => c.name));
  });

  it("uses the dataset id and price the marketplace shows", () => {
    const listing = DEMO_DATASETS.find((d) => d.id === COFFEE_DATASET.id);
    expect(listing?.priceCents).toBe(COFFEE_DATASET.priceCents);
  });

  it("matches the reviewed digest single-sandbox mode allows", () => {
    const entry = SYNTHETIC_DATASET_REGISTRY[COFFEE_DATASET.id];
    expect(createHash("sha256").update(readFileSync(COFFEE_DATASET.path)).digest("hex")).toBe(entry.sha256);
    expect(entry.tableName).toBe(COFFEE_DATASET.tableName);
  });
});
