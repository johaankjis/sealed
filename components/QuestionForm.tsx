"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";
import { ApiError, createCheckout, createJob } from "./api";
import { formatPrice } from "./datasets";

export function QuestionForm({
  datasetId,
  priceCents,
  sampleQuestions,
}: {
  datasetId: string;
  priceCents: number;
  sampleQuestions: string[];
}) {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
    if (q.length < 10 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const job = await createJob(datasetId, q);
      try {
        const checkout = await createCheckout(job.id);
        window.location.href = checkout.checkoutUrl;
      } catch (checkoutErr) {
        // Job exists but checkout failed: send buyer to the job page
        // so they can retry payment instead of losing the job.
        router.push(`/jobs/${encodeURIComponent(job.id)}`);
        return;
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  return (
    <form className="question-form" onSubmit={onSubmit}>
      <label className="field-label" htmlFor="question">
        Ask a question about this dataset
      </label>
      <textarea
        id="question"
        className="question-input"
        rows={3}
        maxLength={500}
        placeholder="e.g. What are the top 5 drink categories by revenue each quarter?"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        disabled={busy}
      />
      <div className="sample-row" aria-label="Sample questions">
        {sampleQuestions.map((s) => (
          <button
            key={s}
            type="button"
            className="sample-chip"
            disabled={busy}
            onClick={() => setQuestion(s)}
          >
            {s}
          </button>
        ))}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-foot">
        <span className="price-note">
          <strong>{formatPrice(priceCents)}</strong> per question · charged via Stripe Checkout
        </span>
        <button type="submit" className="btn-primary" disabled={busy || question.trim().length < 10}>
          {busy ? (
            <>
              <Loader2 className="spin" size={16} /> Creating job…
            </>
          ) : (
            <>
              Continue to payment <ArrowRight size={16} />
            </>
          )}
        </button>
      </div>
    </form>
  );
}
