export type QueryColumn = {
    name: string;
    type?: string;
};

export type QueryResultRow = Record<string, unknown>;

export type DatasetQueryResult = {
    columns: QueryColumn[];
    rows: QueryResultRow[];
    rowCount: number;
    executionTimeMs?: number;
    truncated: boolean;
    queryId?: string;
};

export type DatasetQueryRequest = {
    datasetUrn: string;
    sql: string;
};
