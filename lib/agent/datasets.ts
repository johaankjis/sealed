// Dataset metadata the agent needs to write code. Only schema information is
// shared with Claude; dataset rows never leave the sandbox.
// NOTE: candidate for contracts/ once frontend and sandbox agree on shape.

export interface DatasetColumn {
  name: string;
  type: string;
  description?: string;
}

export interface DatasetDescriptor {
  id: string;
  name: string;
  description: string;
  /** Path the sandbox runtime uses in prepareDataset. Never sent to buyers. */
  path: string;
  /** DuckDB table/view name the generated code queries. */
  tableName: string;
  columns: DatasetColumn[];
  /** Total records; used to cross-check reported group sizes. */
  rowCount: number;
  priceCents: number;
}

export interface DatasetCatalog {
  get(id: string): Promise<DatasetDescriptor | undefined>;
}

export class StaticDatasetCatalog implements DatasetCatalog {
  private byId: Map<string, DatasetDescriptor>;

  constructor(datasets: DatasetDescriptor[]) {
    this.byId = new Map(datasets.map((d) => [d.id, d]));
  }

  async get(id: string) {
    return this.byId.get(id);
  }
}
