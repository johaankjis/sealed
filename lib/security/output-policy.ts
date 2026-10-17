import type {
  ApprovedResult,
  ExecutionResult,
  OutputPolicy,
  ResultValue,
  ValidationDecision,
} from "../../contracts/results";

/**
 * Server-side output policy.
 *
 * Security posture: fail closed. A result is published only when it
 * carries trusted group-size evidence and passes aggregate-only,
 * size, identifier, and overlap checks. Missing, inconsistent, or
 * suspicious evidence is rejected with a reason — there is no
 * fallback path that publishes unverified data.
 */

export interface AggregateOnlyPolicyOptions {
  /** Minimum number of underlying records any published group must represent (k-anonymity style). */
  minGroupSize: number;
  /** Maximum number of rows a result may contain. */
  maxRows: number;
  /** Maximum number of columns a result may contain. */
  maxColumns: number;
  /** Maximum length of any single string cell. */
  maxCellLength: number;
  /** Reject results whose row count equals the row cap (likely truncated dumps). */
  rejectRowCapSaturation: boolean;
  /** Maximum drill-down depth per dimension chain (0 forbids any refinement). */
  maxRefinementDepth: number;
  /** Reject same-column queries that narrow a previously approved slice. */
  rejectSliceProbing: boolean;
  /** Rolling memory of approved results backing overlap detection. */
  maxTrackedResults: number;
  /** Column-name tokens that identify people, devices, or records. */
  deniedColumnTokens: string[];
}

export const DEFAULT_OUTPUT_POLICY_OPTIONS: AggregateOnlyPolicyOptions = {
  minGroupSize: 10,
  maxRows: 200,
  maxColumns: 20,
  maxCellLength: 200,
  rejectRowCapSaturation: true,
  maxRefinementDepth: 2,
  rejectSliceProbing: true,
  maxTrackedResults: 20,
  deniedColumnTokens: [
    // contact / government identity
    "email", "mail", "ssn", "social", "phone", "mobile",
    "address", "street", "zip", "postal", "passport", "license", "iban",
    // people and entities (grouping by these = per-person output)
    "username", "user", "customer", "cust", "buyer", "seller", "vendor",
    "member", "patient", "employee", "subscriber", "visitor", "account",
    // devices, identifiers, credentials
    "card", "device", "session", "token", "password", "secret",
    "id", "uuid", "guid", "hash", "ip",
    // quasi-identifiers
    "birth", "dob", "latitude", "longitude", "lat", "lon", "geo", "location",
  ],
};

/** Record-identifier column suffixes; such columns must never be dimensions. */
const DENIED_COLUMN_SUFFIXES = ["_id", "_uuid", "_guid", "_hash"];

/** Person-name column shapes such as first_name / last_name / full_name. */
const PERSON_NAME_PATTERN = /(^|_)(first|last|full|middle)_name($|_)/;

/**
 * Exact column names whose values are expected to equal the
 * per-row groupSizes. When such a column is present it must
 * corroborate the reported group sizes; disagreement is treated
 * as fabricated evidence.
 */
const COUNT_COLUMN_NAMES = new Set([
  "count", "cnt", "n", "records", "rows", "frequency",
  "record_count", "row_count", "num_records", "num_rows",
  "n_records", "n_rows",
]);

/** Matches email-shaped values inside arbitrary string cells. */
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/;

/** Label values that look temporal, used to pick a line chart. */
const DATE_LABEL_PATTERN =
  /^(\d{4}([-/]\d{2}){0,2}|Q[1-4][ -]?\d{4}|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[ -]?\d{2,4})$/i;

class ValidationError extends Error {}

interface LedgerEntry {
  /** Sorted column names of the approved result. */
  columns: string[];
  /** Sorted non-numeric (dimension) column names. */
  dimensionColumns: string[];
  /** Joined dimension values per row. */
  dimensionKeys: Set<string>;
  /** Drill-down depth this result was approved at. */
  depth: number;
}

type ResultRow = Record<string, ResultValue>;

export class AggregateOnlyOutputPolicy implements OutputPolicy {
  private readonly options: AggregateOnlyPolicyOptions;
  private readonly deniedTokens: Set<string>;
  /** Rolling memory of approved results; backs overlap detection. */
  private readonly ledger: LedgerEntry[] = [];

  constructor(options: Partial<AggregateOnlyPolicyOptions> = {}) {
    this.options = { ...DEFAULT_OUTPUT_POLICY_OPTIONS, ...options };
    this.deniedTokens = new Set(this.options.deniedColumnTokens);
  }

  async validate(result: ExecutionResult): Promise<ValidationDecision> {
    try {
      return { approved: true, result: this.buildApprovedResult(result) };
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "result failed validation";
      return { approved: false, reason };
    }
  }

  /**
   * Synchronous core so callers (and tests) can inspect rejection
   * reasons directly; `validate` wraps it in the contract shape.
   * Approving a result records it in the overlap ledger, so this
   * method is stateful by design.
   */
  buildApprovedResult(result: ExecutionResult): ApprovedResult {
    const { columns, rows, groupSizes } = result;

    if (!Array.isArray(columns) || columns.length === 0) {
      throw new ValidationError("result has no columns");
    }
    if (columns.length > this.options.maxColumns) {
      throw new ValidationError(
        `result has ${columns.length} columns, limit is ${this.options.maxColumns}`
      );
    }
    const seen = new Set<string>();
    for (const column of columns) {
      if (typeof column !== "string" || column.length === 0) {
        throw new ValidationError("result contains an unnamed column");
      }
      if (seen.has(column)) {
        throw new ValidationError(`duplicate column name: ${column}`);
      }
      seen.add(column);
      this.assertColumnAllowed(column);
    }

    if (!Array.isArray(rows)) {
      throw new ValidationError("result rows are missing");
    }
    if (rows.length > this.options.maxRows) {
      throw new ValidationError(
        `result has ${rows.length} rows, limit is ${this.options.maxRows}; ` +
          `results must be aggregated, not raw record dumps`
      );
    }
    if (
      this.options.rejectRowCapSaturation &&
      rows.length > 0 &&
      rows.length === this.options.maxRows
    ) {
      throw new ValidationError(
        `result fills the entire row limit (${this.options.maxRows}); ` +
          `truncated or unaggregated output is rejected`
      );
    }

    for (let i = 0; i < rows.length; i++) {
      this.assertRowShape(columns, rows[i], i);
    }

    this.assertGroupSizes(groupSizes, rows.length);
    this.assertCountCorroboration(columns, rows, groupSizes as number[]);

    const dimensionColumns = this.dimensionColumns(columns, rows);
    const dimensionKeys = this.dimensionKeySet(
      [...dimensionColumns].sort(),
      rows
    );
    if (rows.length > 0) {
      this.assertNoOverlap(columns, dimensionColumns, dimensionKeys);
      this.recordApproval(columns, dimensionColumns, dimensionKeys);
    }

    return {
      summary: `Aggregated result with ${rows.length} row(s) across ${columns.length} column(s).`,
      columns,
      rows,
      chartType: this.pickChartType(columns, rows),
    };
  }

  // ---- column policy ----------------------------------------------------

  private assertColumnAllowed(column: string): void {
    const normalized = column.toLowerCase().replace(/\s+/g, "_");
    const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
    for (const token of tokens) {
      if (this.deniedTokens.has(token)) {
        throw new ValidationError(
          `column "${column}" may expose identifying or sensitive data`
        );
      }
    }
    for (const suffix of DENIED_COLUMN_SUFFIXES) {
      if (normalized.endsWith(suffix)) {
        throw new ValidationError(
          `column "${column}" is a record identifier and cannot be an output dimension`
        );
      }
    }
    if (PERSON_NAME_PATTERN.test(normalized)) {
      throw new ValidationError(
        `column "${column}" may expose identifying or sensitive data`
      );
    }
  }

  // ---- row and cell policy ----------------------------------------------

  private assertRowShape(columns: string[], row: ResultRow, index: number): void {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new ValidationError(`row ${index} is not an object`);
    }
    const keys = Object.keys(row);
    if (keys.length !== columns.length) {
      throw new ValidationError(`row ${index} does not match the column set`);
    }
    for (const key of keys) {
      if (!columns.includes(key)) {
        throw new ValidationError(`row ${index} has unexpected column "${key}"`);
      }
      this.assertCellValue(key, row[key], index);
    }
  }

  private assertCellValue(column: string, value: ResultValue, rowIndex: number): void {
    if (value === null) {
      return;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return;
    }
    if (typeof value !== "string") {
      throw new ValidationError(
        `row ${rowIndex} column "${column}" has an unsupported value type`
      );
    }
    if (value.length > this.options.maxCellLength) {
      throw new ValidationError(
        `row ${rowIndex} column "${column}" exceeds the maximum cell length; ` +
          `free-form payloads are not allowed in results`
      );
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
      throw new ValidationError(
        `row ${rowIndex} column "${column}" contains control characters`
      );
    }
    if (EMAIL_PATTERN.test(value)) {
      throw new ValidationError(
        `row ${rowIndex} column "${column}" contains an email-shaped value`
      );
    }
  }

  // ---- group-size evidence ----------------------------------------------

  /**
   * Fail closed: groupSizes are mandatory, not optional. Without
   * per-group record counts there is no way to distinguish a real
   * aggregate from a raw dump or a single-customer row, so results
   * without them are always rejected.
   */
  private assertGroupSizes(groupSizes: unknown, rowCount: number): void {
    if (!Array.isArray(groupSizes)) {
      throw new ValidationError(
        "result is missing groupSizes evidence (fail closed): " +
          "unverified aggregates are never published"
      );
    }
    if (
      groupSizes.length !== rowCount ||
      groupSizes.some((size) => !Number.isInteger(size) || size < 0)
    ) {
      throw new ValidationError(
        "groupSizes must be a non-negative integer array with one entry per row"
      );
    }
    if (rowCount === 0) {
      return;
    }
    const total = (groupSizes as number[]).reduce((sum, size) => sum + size, 0);
    if (total < rowCount) {
      throw new ValidationError(
        "groupSizes are internally inconsistent: reported groups cover " +
          `fewer records (${total}) than published rows (${rowCount})`
      );
    }
    for (let i = 0; i < rowCount; i++) {
      if ((groupSizes as number[])[i] < this.options.minGroupSize) {
        throw new ValidationError(
          `row ${i} represents ${(groupSizes as number[])[i]} record(s), below the minimum ` +
            `group size of ${this.options.minGroupSize}`
        );
      }
    }
  }

  /**
   * Fabrication tripwire: when the sandbox includes a row-count
   * column, its values must agree with the reported groupSizes.
   * Disagreement means one of the two is fabricated; both are
   * untrustworthy, so the result is rejected.
   */
  private assertCountCorroboration(
    columns: string[],
    rows: ResultRow[],
    groupSizes: number[]
  ): void {
    for (const column of columns) {
      const normalized = column.toLowerCase().replace(/\s+/g, "_");
      if (!COUNT_COLUMN_NAMES.has(normalized)) {
        continue;
      }
      for (let i = 0; i < rows.length; i++) {
        const value = rows[i][column];
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value !== groupSizes[i]
        ) {
          throw new ValidationError(
            `column "${column}" conflicts with group-size evidence in row ${i}; ` +
              `results with inconsistent size claims are rejected`
          );
        }
      }
    }
  }

  // ---- overlap detection --------------------------------------------------

  private dimensionColumns(columns: string[], rows: ResultRow[]): string[] {
    const numeric = new Set<string>();
    for (const column of columns) {
      if (
        rows.every(
          (row) => typeof row[column] === "number" || row[column] === null
        )
      ) {
        numeric.add(column);
      }
    }
    return columns.filter((column) => !numeric.has(column));
  }

  private dimensionKeySet(
    dimensionColumns: string[],
    rows: ResultRow[]
  ): Set<string> {
    const keys = new Set<string>();
    for (const row of rows) {
      keys.add(dimensionColumns.map((c) => `${row[c]}`).join("\u0001"));
    }
    return keys;
  }

  private sameColumns(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((column, i) => column === b[i]);
  }

  /**
   * Depth of a new result within a drill-down chain: one plus the
   * maximum depth of any approved result whose dimension set is a
   * strict subset of the new one. 0 means a fresh base slice.
   */
  private chainDepth(dimensionColumns: string[]): number {
    let deepest = -1;
    for (const entry of this.ledger) {
      if (entry.dimensionColumns.length === 0) {
        continue;
      }
      const isRefinementOf =
        entry.dimensionColumns.length < dimensionColumns.length &&
        entry.dimensionColumns.every((d) => dimensionColumns.includes(d));
      if (isRefinementOf) {
        deepest = Math.max(deepest, entry.depth);
      }
    }
    return deepest + 1;
  }

  private assertNoOverlap(
    columns: string[],
    dimensionColumns: string[],
    dimensionKeys: Set<string>
  ): void {
    if (this.ledger.length === 0) {
      return;
    }

    const depth = this.chainDepth(dimensionColumns);
    if (depth > this.options.maxRefinementDepth) {
      throw new ValidationError(
        `overlapping-query policy: drill-down depth ${depth} exceeds the limit of ` +
          `${this.options.maxRefinementDepth}; repeated refinement of the same slice is rejected`
      );
    }

    if (this.options.rejectSliceProbing) {
      const sortedColumns = [...columns].sort();
      for (const entry of this.ledger) {
        const narrowsPriorSlice =
          this.sameColumns(sortedColumns, entry.columns) &&
          entry.dimensionKeys.size > 0 &&
          dimensionKeys.size > 0 &&
          dimensionKeys.size < entry.dimensionKeys.size &&
          [...dimensionKeys].every((key) => entry.dimensionKeys.has(key));
        if (narrowsPriorSlice) {
          throw new ValidationError(
            "overlapping-query policy: this query narrows a previously approved slice; " +
              "overlapping probes are rejected"
          );
        }
      }
    }
  }

  private recordApproval(
    columns: string[],
    dimensionColumns: string[],
    dimensionKeys: Set<string>
  ): void {
    this.ledger.push({
      columns: [...columns].sort(),
      dimensionColumns: [...dimensionColumns].sort(),
      dimensionKeys,
      depth: this.chainDepth(dimensionColumns),
    });
    while (this.ledger.length > this.options.maxTrackedResults) {
      this.ledger.shift();
    }
  }

  // ---- presentation -------------------------------------------------------

  private pickChartType(
    columns: string[],
    rows: ResultRow[]
  ): ApprovedResult["chartType"] {
    if (rows.length === 0) {
      return "none";
    }
    const numeric = new Set<string>();
    for (const column of columns) {
      if (
        rows.every(
          (row) => typeof row[column] === "number" || row[column] === null
        )
      ) {
        numeric.add(column);
      }
    }
    const dimensionColumns = columns.filter((column) => !numeric.has(column));
    if (numeric.size !== 1 || dimensionColumns.length === 0) {
      return "none";
    }
    const dimension = dimensionColumns[0];
    const labels = rows
      .map((row) => row[dimension])
      .filter((value): value is string => typeof value === "string");
    if (
      labels.length === rows.length &&
      labels.every((label) => DATE_LABEL_PATTERN.test(label.trim()))
    ) {
      return "line";
    }
    return "bar";
  }
}
