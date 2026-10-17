import Link from "next/link";
import { JobStatusBadge } from "../../../components/JobStatusBadge";
import { ResultChart } from "../../../components/ResultChart";
import { ResultTable } from "../../../components/ResultTable";
import { SecurityNotice } from "../../../components/SecurityNotice";
import { DEMO_JOB } from "../../../components/demo-result";

/** Static preview of a completed job so the result UI is demonstrable
 *  before backend routes exist. Clearly labeled as a demo. */
export default function DemoJobPage() {
  const job = DEMO_JOB;
  return (
    <div className="wrap">
      <p className="crumb">
        <Link href="/">Marketplace</Link> / Demo result
      </p>
      <div className="demo-banner" role="note">
        <strong>Demo preview.</strong> This is fixture data showing what a completed job looks like.
        Real results arrive here after payment, sandbox analysis, and safety validation.
      </div>
      <div className="job-head">
        <JobStatusBadge status={job.status} />
      </div>
      <blockquote className="job-question">“{job.question}”</blockquote>
      {job.result && (
        <div className="panel result-panel">
          <h2>Approved result</h2>
          <p className="result-summary">{job.result.summary}</p>
          <ResultChart result={job.result} />
          <ResultTable result={job.result} />
          <SecurityNotice />
        </div>
      )}
    </div>
  );
}
