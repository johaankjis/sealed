import { Lock } from "lucide-react";

/** Buyer-facing privacy note. States process facts only — no egress claims. */
export function SecurityNotice({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <p className="security-note small">
        <Lock size={14} /> Aggregate results only. Raw dataset records are never shown.
      </p>
    );
  }
  return (
    <aside className="security-box">
      <Lock size={16} />
      <div>
        <strong>Why you can trust this result</strong>
        <p className="small muted">
          This output passed an automated safety check: aggregates only, no identifiers, and minimum group
          sizes. The underlying dataset stayed inside its isolated sandbox for the whole run.
        </p>
      </div>
    </aside>
  );
}
