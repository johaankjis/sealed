import type { ApprovedResult } from "../contracts/results";

function cell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(2);
  }
  return String(value);
}

/** Renders only validated ApprovedResult rows. Never raw sandbox output. */
export function ResultTable({ result }: { result: ApprovedResult }) {
  return (
    <div className="table-wrap">
      <table className="result-table">
        <thead>
          <tr>
            {result.columns.map((col) => (
              <th key={col} scope="col">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i}>
              {result.columns.map((col) => (
                <td key={col}>{cell(row[col])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
