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
    connectionId?: string;
};

export type DatasetQueryRequest = {
    datasetUrn: string;
    sql: string;
    connectionId: string;
};

export type QueryConnection = {
    id: string;
    label: string;
    platform: string;
    database: string;
};

export type QueryConnectionsResult = {
    connections: QueryConnection[];
    defaultConnectionId?: string;
    maxRows: number;
};
