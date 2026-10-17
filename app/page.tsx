import Link from "next/link";
import { ArrowDown } from "lucide-react";
import { DEMO_DATASETS, formatPrice } from "../components/datasets";

export default function Home() {
  return (
    <div className="wrap">
      <section className="masthead">
        <h1>
          Buy the answer. <span className="stamp">Never the data.</span>
        </h1>
        <p className="lede">
          Sealed is a marketplace for insights computed on private datasets. Ask a question, pay a flat
          fee, and an AI analyst runs your query inside an isolated sandbox. You receive a validated
          chart or table — the raw records stay sealed.
        </p>
        <div className="masthead-row">
          <a className="btn-primary" href="#datasets">
            Browse datasets <ArrowDown size={16} />
          </a>
          <p className="stat-line">
            <strong>{DEMO_DATASETS.length} datasets</strong> listed · flat fee per question · Stripe-secured
            checkout
          </p>
        </div>
      </section>

      <section id="datasets" aria-label="Dataset marketplace">
        <div className="section-head">
          <h2>The marketplace ledger</h2>
          <span>{DEMO_DATASETS.length} listings</span>
        </div>
        <ul className="ledger">
          {DEMO_DATASETS.map((d) => (
            <li key={d.id} className="ledger-item">
              <div>
                <p className="ledger-owner">{d.owner}</p>
                <h3>
                  <Link href={`/datasets/${d.id}`}>{d.name}</Link>
                </h3>
                <p className="ledger-desc">{d.description}</p>
                <p className="ledger-meta">
                  {d.rowCount} · Updated {d.updatedAt}
                </p>
              </div>
              <div className="ledger-side">
                <span className="ledger-price">{formatPrice(d.priceCents)}</span>
                <Link className="btn-secondary" href={`/datasets/${d.id}`}>
                  Ask a question
                </Link>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section id="how-it-works" aria-label="How it works">
        <div className="section-head">
          <h2>How a purchase works</h2>
          <span>five steps, sealed throughout</span>
        </div>
        <ol className="steps">
          <li>
            <div>
              <strong>Ask your question</strong>
              <p>Pick a dataset and phrase what you want to know. Aggregate questions work best.</p>
            </div>
          </li>
          <li>
            <div>
              <strong>Pay a flat fee</strong>
              <p>Checkout runs through Stripe. Analysis never starts before payment is verified.</p>
            </div>
          </li>
          <li>
            <div>
              <strong>AI writes the analysis</strong>
              <p>An analyst agent generates restricted Python for your question — nothing else.</p>
            </div>
          </li>
          <li>
            <div>
              <strong>It runs in isolation</strong>
              <p>The code executes in a fresh sandbox against a dataset snapshot, then the sandbox is destroyed.</p>
            </div>
          </li>
          <li>
            <div>
              <strong>You get a checked result</strong>
              <p>An automated safety check approves only aggregate, identifier-free results. Anything else is rejected, not shown.</p>
            </div>
          </li>
        </ol>
      </section>
    </div>
  );
}
