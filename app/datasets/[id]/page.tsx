import Link from "next/link";
import { notFound } from "next/navigation";
import { QuestionForm } from "../../../components/QuestionForm";
import { SecurityNotice } from "../../../components/SecurityNotice";
import { formatPrice, getDemoDataset } from "../../../components/datasets";

export default async function DatasetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dataset = getDemoDataset(id);
  if (!dataset) notFound();

  return (
    <div className="wrap">
      <p className="crumb">
        <Link href="/">Marketplace</Link> / {dataset.name}
      </p>
      <div className="dataset-layout">
        <div>
          <p className="ledger-owner">{dataset.owner}</p>
          <h1 className="dataset-title">{dataset.name}</h1>
          <p className="lede">{dataset.description}</p>
          <div className="fact-row">
            <div className="fact">
              Size<strong>{dataset.rowCount}</strong>
            </div>
            <div className="fact">
              Updated<strong>{dataset.updatedAt}</strong>
            </div>
            <div className="fact">
              Price per question<strong>{formatPrice(dataset.priceCents)}</strong>
            </div>
            <div className="fact">
              Delivery<strong>Validated chart or table</strong>
            </div>
          </div>
          <SecurityNotice />
        </div>
        <div className="panel panel-wash">
          <QuestionForm
            datasetId={dataset.id}
            priceCents={dataset.priceCents}
            sampleQuestions={dataset.sampleQuestions}
          />
        </div>
      </div>
    </div>
  );
}
