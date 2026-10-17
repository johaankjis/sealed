import type { ExecutionResult } from "../../contracts/results";

// Fail-closed gate that runs before the shared OutputPolicy. The policy treats
// missing groupSizes as acceptable; the orchestrator does not.
//
// Limitation: groupSizes are produced by generated code inside the sandbox, so
// they are evidence, not proof. The cross-check against the catalog row count
// catches inflated counts, but true provenance needs runner-computed counts
// (see lib/agent/README.md, blockers).

export interface GroupSizeEvidenceOptions {
  minGroupSize: number;
  /** Total records in the dataset, from the trusted catalog. */
  datasetRowCount: number;
}

/** Returns a rejection reason, or undefined when the evidence is acceptable. */
export function checkGroupSizeEvidence(
  result: ExecutionResult,
  options: GroupSizeEvidenceOptions
): string | undefined {
  const { groupSizes, rows } = result;
  if (groupSizes === undefined || groupSizes === null) {
    return "missing groupSizes; every row needs a group size";
  }
  if (!Array.isArray(groupSizes) || groupSizes.length !== rows.length) {
    return "groupSizes must have exactly one entry per row";
  }
  if (groupSizes.some((n) => !Number.isSafeInteger(n) || n < 0)) {
    return "groupSizes must be non-negative integers";
  }
  const small = groupSizes.findIndex((n) => n < options.minGroupSize);
  if (small !== -1) {
    return `row ${small} aggregates fewer than ${options.minGroupSize} records`;
  }
  const total = groupSizes.reduce((sum, n) => sum + n, 0);
  if (!Number.isSafeInteger(options.datasetRowCount) || total > options.datasetRowCount) {
    return "groupSizes are inconsistent with the dataset size; use non-overlapping groups";
  }
  return undefined;
}
