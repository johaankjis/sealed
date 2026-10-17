import Link from "next/link";
import { JobTracker } from "../../../components/JobTracker";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="wrap">
      <p className="crumb">
        <Link href="/">Marketplace</Link> / Job <span className="muted">{id}</span>
      </p>
      <h1 className="dataset-title">Your sealed query</h1>
      <p className="lede">
        Track payment, sandbox analysis, and safety validation. This page updates on its own — keep it
        open or bookmark it.
      </p>
      <JobTracker jobId={id} />
    </div>
  );
}
