import {
    DatasetQueryRequest,
    DatasetQueryResult,
    QueryColumn,
    QueryConnection,
    QueryConnectionsResult,
    QueryResultRow,
} from '@app/entityV2/shared/tabs/Dataset/Explore/types';
import { resolveRuntimePath } from '@utils/runtimeBasePath';

export const QUERY_SERVICE_PATH = '/query-service/v1/query';

type ErrorPayload = {
    message?: unknown;
    detail?: unknown;
    code?: unknown;
};

export class QueryServiceError extends Error {
    status: number;

    code?: string;

    constructor(message: string, status: number, code?: string) {
        super(message);
        this.name = 'QueryServiceError';
        this.status = status;
        this.code = code;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeColumn(value: unknown): QueryColumn | null {
    if (typeof value === 'string' && value.length > 0) {
        return { name: value };
    }
    if (!isRecord(value) || typeof value.name !== 'string' || value.name.length === 0) {
        return null;
    }
    return {
        name: value.name,
        type: typeof value.type === 'string' ? value.type : undefined,
    };
}

function normalizeRows(value: unknown, columns: QueryColumn[]): QueryResultRow[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((row) => {
        if (isRecord(row)) {
            return [row];
        }
        if (Array.isArray(row)) {
            const normalizedRow = columns.reduce<QueryResultRow>(
                (result, column, index) => ({ ...result, [column.name]: row[index] }),
                {},
            );
            return [normalizedRow];
        }
        return [];
    });
}

function normalizeResponse(value: unknown): DatasetQueryResult {
    if (!isRecord(value)) {
        throw new QueryServiceError('The query service returned an invalid response.', 502);
    }

    const columns = Array.isArray(value.columns)
        ? value.columns.map(normalizeColumn).filter((column): column is QueryColumn => column !== null)
        : [];
    const rows = normalizeRows(value.rows, columns);
    const inferredColumns =
        columns.length === 0 && rows.length > 0 ? Object.keys(rows[0] ?? {}).map((name) => ({ name })) : columns;

    return {
        columns: inferredColumns,
        rows,
        rowCount: typeof value.rowCount === 'number' ? value.rowCount : rows.length,
        executionTimeMs: typeof value.executionTimeMs === 'number' ? value.executionTimeMs : undefined,
        truncated: value.truncated === true,
        queryId: typeof value.queryId === 'string' ? value.queryId : undefined,
        connectionId: typeof value.connectionId === 'string' ? value.connectionId : undefined,
    };
}

async function getErrorPayload(response: Response): Promise<ErrorPayload> {
    try {
        const payload: unknown = await response.json();
        return isRecord(payload) ? payload : {};
    } catch {
        return {};
    }
}

async function checkResponse(response: Response): Promise<void> {
    if (!response.ok) {
        const payload = await getErrorPayload(response);
        const message =
            (typeof payload.message === 'string' && payload.message) ||
            (typeof payload.detail === 'string' && payload.detail) ||
            `The query service returned HTTP ${response.status}.`;
        throw new QueryServiceError(
            message,
            response.status,
            typeof payload.code === 'string' ? payload.code : undefined,
        );
    }
}

export async function getQueryConnections(datasetUrn: string, signal?: AbortSignal): Promise<QueryConnectionsResult> {
    const response = await fetch(
        `${resolveRuntimePath('/query-service/v1/connections')}?datasetUrn=${encodeURIComponent(datasetUrn)}`,
        { credentials: 'same-origin', signal },
    );
    await checkResponse(response);
    const value: unknown = await response.json();
    if (!isRecord(value) || !Array.isArray(value.connections)) {
        throw new QueryServiceError('The query service returned an invalid connection list.', 502);
    }
    const connections = value.connections.map((item): QueryConnection => {
        if (
            !isRecord(item) ||
            typeof item.id !== 'string' ||
            !item.id ||
            typeof item.label !== 'string' ||
            typeof item.platform !== 'string' ||
            typeof item.database !== 'string'
        ) {
            throw new QueryServiceError('The query service returned an invalid connection.', 502);
        }
        return { id: item.id, label: item.label, platform: item.platform, database: item.database };
    });
    return {
        connections,
        defaultConnectionId:
            typeof value.defaultConnectionId === 'string' &&
            connections.some((item) => item.id === value.defaultConnectionId)
                ? value.defaultConnectionId
                : undefined,
        maxRows:
            typeof value.maxRows === 'number' && Number.isInteger(value.maxRows) && value.maxRows > 0
                ? value.maxRows
                : 100,
    };
}

export async function runDatasetQuery(request: DatasetQueryRequest, signal?: AbortSignal): Promise<DatasetQueryResult> {
    const response = await fetch(resolveRuntimePath(QUERY_SERVICE_PATH), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal,
    });
    await checkResponse(response);
    return normalizeResponse(await response.json());
}
