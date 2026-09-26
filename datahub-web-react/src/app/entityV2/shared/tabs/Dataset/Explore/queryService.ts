import {
    DatasetQueryRequest,
    DatasetQueryResult,
    QueryColumn,
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

export async function runDatasetQuery(request: DatasetQueryRequest, signal?: AbortSignal): Promise<DatasetQueryResult> {
    const response = await fetch(resolveRuntimePath(QUERY_SERVICE_PATH), {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal,
    });

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

    return normalizeResponse(await response.json());
}
