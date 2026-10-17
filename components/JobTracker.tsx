"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type { QueryJob } from "../contracts/job";
import { ApiError, getJob } from "./api";
import { JobStatusBadge } from "./JobStatusBadge";
import { ResultChart } from "./ResultChart";
import { ResultTable } from "./ResultTable";
import { SecurityNotice } from "./SecurityNotice";
import { FAILED_GUIDANCE, LIFECYCLE_STEPS, failedStepIndex, isTerminalStatus } from "./job-status";

const POLL_MS = 2500;

function Lifecycle({ job }: { job: QueryJob }) {
  const failedAt = failedStepIndex(job.status);
  return (
    <ol className="lifecycle">
      {LIFECYCLE_STEPS.map((step, i) => {
        const reached = step.activeOn.includes(job.status);
        const failed = i === failedAt;
        return (
          <li key={step.key} className={`lifecycle-step${reached ? " reached" : ""}${failed ? " failed" : ""}`}>
            <span className="lifecycle-marker" aria-hidden="true">
              {reached ? "●" : "○"}
            </span>
            <span>{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Polls GET /api/jobs/:id until the job reaches a terminal status. */
export function JobTracker({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<QueryJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(true);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await getJob(jobId);
      setJob(next);
      setError(null);
      if (isTerminalStatus(next.status)) {
        setPolling(false);
        if (timer.current) clearInterval(timer.current);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this job.");
      setPolling(false);
      if (timer.current) clearInterval(timer.current);
    }
  }, [jobId]);

  useEffect(() => {
    void load();
    timer.current = setInterval(() => void load(), POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [load]);

  function retry() {
    setPolling(true);
    setError(null);
    void load();
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => void load(), POLL_MS);
  }

  if (error && !job) {
    return (
      <div className="panel">
        <p className="form-error" role="alert">
          {error}
        </p>
        <button type="button" className="btn-secondary" onClick={retry}>
          <RefreshCw size={16} /> Retry
        </button>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="panel">
        <p className="muted">Loading job…</p>
      </div>
    );
  }

  const failed = job.status === "rejected" || job.status === "payment_failed" || job.status === "execution_failed";

  return (
    <div className="job-grid">
      <div className="panel">
        <div className="job-head">
          <JobStatusBadge status={job.status} />
          {!isTerminalStatus(job.status) && polling && (
            <span className="muted small">
              <span className="pulse" aria-hidden="true" /> Updating automatically…
            </span>
          )}
        </div>
        <blockquote className="job-question">“{job.question}”</blockquote>
        <Lifecycle job={job} />
        {failed && (
          <div className="failure-box" role="alert">
            <AlertTriangle size={16} />
            <div>
              <p>{FAILED_GUIDANCE[job.status] ?? "This job did not complete."}</p>
              {job.errorCode && <p className="small muted">Reference: {job.errorCode}</p>}
            </div>
          </div>
        )}
        {isTerminalStatus(job.status) && (
          <button type="button" className="btn-secondary" onClick={retry}>
            <RefreshCw size={16} /> Refresh
          </button>
        )}
      </div>

      {job.status === "completed" && job.result ? (
        <div className="panel result-panel">
          <h2>Approved result</h2>
          <p className="result-summary">{job.result.summary}</p>
          <ResultChart result={job.result} />
          <ResultTable result={job.result} />
          <SecurityNotice />
        </div>
      ) : (
        <div className="panel">
          <h2>What happens next</h2>
          <p className="muted">
            Your question runs inside an isolated sandbox against the private dataset. Only an aggregate result
            that passes the safety check is shown here — raw records never leave the sandbox.
          </p>
          <SecurityNotice compact />
        </div>
      )}
    </div>
  );
}
