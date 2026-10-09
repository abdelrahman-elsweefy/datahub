import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    QUERY_SERVICE_PATH,
    QueryServiceError,
    runDatasetQuery,
} from '@app/entityV2/shared/tabs/Dataset/Explore/queryService';

vi.mock('@utils/runtimeBasePath', () => ({
    resolveRuntimePath: vi.fn((path: string) => path),
}));

const DATASET_URN = 'urn:li:dataset:(urn:li:dataPlatform:postgres,my_db.my_schema.events,PROD)';

function responseWith(payload: unknown, ok = true, status = 200): Response {
    return {
        ok,
        status,
        json: vi.fn().mockResolvedValue(payload),
    } as unknown as Response;
}

describe('runDatasetQuery', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        vi.clearAllMocks();
    });

    it('sends the asset URN and normalizes array rows from the service', async () => {
        global.fetch = vi.fn().mockResolvedValue(
            responseWith({
                columns: [
                    { name: 'id', type: 'integer' },
                    { name: 'event_name', type: 'text' },
                ],
                rows: [[1, 'created']],
                rowCount: 1,
                executionTimeMs: 12,
                truncated: false,
            }),
        );

        const result = await runDatasetQuery({ datasetUrn: DATASET_URN, sql: 'SELECT * FROM my_schema.events' });

        expect(global.fetch).toHaveBeenCalledWith(
            QUERY_SERVICE_PATH,
            expect.objectContaining({
                method: 'POST',
                credentials: 'same-origin',
                body: JSON.stringify({
                    datasetUrn: DATASET_URN,
                    sql: 'SELECT * FROM my_schema.events',
                }),
            }),
        );
        expect(result.rows).toEqual([{ id: 1, event_name: 'created' }]);
        expect(result.rowCount).toBe(1);
    });

    it('surfaces the service status and safe error payload', async () => {
        global.fetch = vi
            .fn()
            .mockResolvedValue(
                responseWith({ detail: 'Only read-only queries are allowed', code: 'READ_ONLY' }, false, 400),
            );

        await expect(runDatasetQuery({ datasetUrn: DATASET_URN, sql: 'DELETE FROM events' })).rejects.toMatchObject({
            name: QueryServiceError.name,
            message: 'Only read-only queries are allowed',
            status: 400,
            code: 'READ_ONLY',
        });
    });
});
