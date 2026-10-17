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
 * Enforces the security boundary that buyers only ever receive
 * aggregated, validated results — never raw records, never
 * unvalidated sandbox output. This is the backstop: even if
 * generated code or a sandbox misbehaves, nothing leaves the
 * server unless it passes this policy.
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
  /** Column-name substrings that identify people or devices and must never appear in output. */
  deniedColumnSubstrings: string[];
}

export const DEFAULT_OUTPUT_POLICY_OPTIONS: AggregateOnlyPolicyOptions = {
  minGroupSize: 10,
  maxRows: 200,
  maxColumns: 20,
  maxCellLength: 200,
  deniedColumnSubstrings: [
    "email",
    "e-mail",
    "ssn",
    "social_security",
    "phone",
    "mobile",
    "address",
    "first_name",
    "last_name",
    "full_name",
    "username",
    "birth",
    "dob",
    "passport",
    "license",
    "iban",
    "card_number",
    "device_id",
    "ip_",
    "_ip",
    "token",
    "password",
  ],
};

/** Columns ending in these suffixes are record identifiers, not dimensions. */
const DENIED_COLUMN_SUFFIXES = ["_id", "_uuid", "_guid", "_hash"];

/** Matches email-shaped values inside arbitrary string cells. */
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/;

class ValidationError extends Error {}

/** Label values that look temporal, used to pick a line chart. */
const DATE_LABEL_PATTERN =
  /^(\d{4}([-/]\d{2}){0,2}|Q[1-4][ -]?\d{4}|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[ -]?\d{2,4})$/i;

export class AggregateOnlyOutputPolicy implements OutputPolicy {
  private readonly options: AggregateOnlyPolicyOptions;

  constructor(options: Partial<AggregateOnlyPolicyOptions> = {}) {
    this.options = { ...DEFAULT_OUTPUT_POLICY_OPTIONS, ...options };
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

    for (let i = 0; i < rows.length; i++) {
      this.assertRowShape(columns, rows[i], i);
    }

    this.assertGroupSizes(groupSizes, rows.length);

    return {
      summary: `Aggregated result with ${rows.length} row(s) across ${columns.length} column(s).`,
      columns,
      rows,
      chartType: this.pickChartType(columns, rows),
    };
  }

  private assertColumnAllowed(column: string): void {
    const normalized = column.toLowerCase().replace(/\s+/g, "_");
    for (const denied of this.options.deniedColumnSubstrings) {
      if (normalized.includes(denied)) {
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
  }

  private assertRowShape(
    columns: string[],
    row: Record<string, ResultValue>,
    index: number
  ): void {
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

  private assertCellValue(
    column: string,
    value: ResultValue,
    rowIndex: number
  ): void {
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

  private assertGroupSizes(
    groupSizes: number[] | undefined,
    rowCount: number
  ): void {
    if (groupSizes === undefined) {
      // No group metadata: the row cap is the only backstop. Documented
      // limitation — sandboxes should always report group sizes.
      return;
    }
    if (
      !Array.isArray(groupSizes) ||
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
    for (let i = 0; i < groupSizes.length; i++) {
      if (groupSizes[i] < this.options.minGroupSize) {
        throw new ValidationError(
          `row ${i} represents ${groupSizes[i]} record(s), below the minimum ` +
            `group size of ${this.options.minGroupSize}`
        );
      }
    }
  }

  private pickChartType(
    columns: string[],
    rows: Array<Record<string, ResultValue>>
  ): ApprovedResult["chartType"] {
    if (rows.length === 0) {
      return "none";
    }
    // A column counts as numeric when every value is a number or null.
    const numericColumns = columns.filter((column) =>
      rows.every(
        (row) => typeof row[column] === "number" || row[column] === null
      )
    );
    const dimensionColumns = columns.filter(
      (column) => !numericColumns.includes(column)
    );
    if (numericColumns.length !== 1 || dimensionColumns.length === 0) {
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
