import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    AI_SERVICE_PATH,
    AskAiServiceError,
    LOCAL_AI_SERVICE_PORT,
    askDatasetAi,
} from '@app/entityV2/shared/sidebarSection/AskAi/askAiService';

vi.mock('@utils/runtimeBasePath', () => ({
    resolveRuntimePath: vi.fn((path: string) => path),
}));

const DATASET_URN = 'urn:li:dataset:(urn:li:dataPlatform:postgres,my_db.my_schema.events,PROD)';
const USER_URN = 'urn:li:corpuser:user1';
const PASTED_SQL_QUESTION = 'Improve this query:\nSELECT * FROM my_schema.events';

function responseWith(payload: unknown, ok = true, status = 200): Response {
    return {
        ok,
        status,
        json: vi.fn().mockResolvedValue(payload),
    } as unknown as Response;
}

describe('askDatasetAi', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        vi.clearAllMocks();
    });

    it('sends dataset and user context and normalizes a SQL action', async () => {
        global.fetch = vi.fn().mockResolvedValue(
            responseWith({
                requestId: 'request-1',
                conversationId: 'conversation-1',
                messageId: 'message-1',
                answer: 'Here is a query.',
                sqlAction: {
                    type: 'CREATE_TAB',
                    title: 'Daily events',
                    statement: 'SELECT * FROM my_schema.events',
                    dialect: 'postgresql',
                },
                sources: [],
            }),
        );
        const request = {
            context: { datasetUrn: DATASET_URN, userUrn: USER_URN },
            question: PASTED_SQL_QUESTION,
            conversationId: null,
            target: { mode: 'NEW_TAB' as const },
        };

        const response = await askDatasetAi(request);

        expect(global.fetch).toHaveBeenCalledWith(
            `http://localhost:${LOCAL_AI_SERVICE_PORT}${AI_SERVICE_PATH}`,
            expect.objectContaining({
                method: 'POST',
                credentials: 'same-origin',
                body: JSON.stringify(request),
            }),
        );
        expect(response.sqlAction?.type).toBe('CREATE_TAB');
        expect(response.requestId).toBe('request-1');
    });

    it('ignores the removed update-tab response action', async () => {
        global.fetch = vi.fn().mockResolvedValue(
            responseWith({
                conversationId: 'conversation-1',
                messageId: 'message-1',
                answer: 'Here is a revised query.',
                sqlAction: {
                    type: 'UPDATE_TAB',
                    targetTabId: 'tab-1',
                    title: 'Daily events',
                    statement: 'SELECT * FROM my_schema.events LIMIT 10',
                    dialect: 'postgresql',
                },
                sources: [],
            }),
        );

        const response = await askDatasetAi({
            context: { datasetUrn: DATASET_URN, userUrn: USER_URN },
            question: PASTED_SQL_QUESTION,
            target: { mode: 'NEW_TAB' },
        });

        expect(response.sqlAction).toBeUndefined();
    });

    it('surfaces a safe service error', async () => {
        global.fetch = vi
            .fn()
            .mockResolvedValue(responseWith({ message: 'Dataset access denied', code: 'FORBIDDEN' }, false, 403));

        await expect(
            askDatasetAi({
                context: { datasetUrn: DATASET_URN, userUrn: USER_URN },
                question: 'Create a query',
                target: { mode: 'NEW_TAB' },
            }),
        ).rejects.toMatchObject({
            name: AskAiServiceError.name,
            message: 'Dataset access denied',
            status: 403,
            code: 'FORBIDDEN',
        });
    });
});
