import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AskAiConversation, AskAiMessage } from '@app/entityV2/shared/sidebarSection/AskAi/askAi.types';
import {
    AI_SERVICE_PATH,
    AskAiServiceError,
    askDatasetAi,
    deleteAiConversation,
    listAiConversations,
    loadAiConversation,
    renameAiConversation,
} from '@app/entityV2/shared/sidebarSection/AskAi/askAiService';

vi.mock('@utils/runtimeBasePath', () => ({ resolveRuntimePath: vi.fn((path: string) => `/datahub${path}`) }));

const DATASET_URN = 'urn:li:dataset:(urn:li:dataPlatform:postgres,my_db.my_schema.events,PROD)';
const CONVERSATION: AskAiConversation = {
    id: 'conversation-1',
    title: 'Dataset analysis',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
};
const MESSAGE: AskAiMessage = {
    id: 'message-1',
    sequence: 1,
    role: 'assistant',
    text: 'Here is a query.',
    datasetUrn: DATASET_URN,
    datasetName: 'events',
    createdAt: '2026-01-01',
    requestId: 'request-1',
    status: 'completed',
    sources: [],
};

function responseWith(payload: unknown, ok = true, status = 200): Response {
    return { ok, status, json: vi.fn().mockResolvedValue(payload) } as unknown as Response;
}

const RESPONSE = {
    requestId: 'request-1',
    conversationId: CONVERSATION.id,
    messageId: MESSAGE.id,
    answer: MESSAGE.text,
    sqlAction: { type: 'CREATE_TAB', title: 'Preview', statement: 'SELECT 1', dialect: 'postgresql' },
    conversation: CONVERSATION,
    userMessage: { ...MESSAGE, id: 'user-1', role: 'user' },
    assistantMessage: MESSAGE,
    sources: [],
};

describe('Ask AI service', () => {
    let originalFetch: typeof global.fetch;
    beforeEach(() => {
        originalFetch = global.fetch;
    });
    afterEach(() => {
        global.fetch = originalFetch;
        vi.clearAllMocks();
    });

    it('sends questions through the authenticated same-origin proxy with a retry ID', async () => {
        global.fetch = vi.fn().mockResolvedValue(responseWith(RESPONSE));
        const request = {
            context: { datasetUrn: DATASET_URN },
            question: 'Improve this query:\nSELECT 1',
            conversationId: CONVERSATION.id,
            requestId: 'request-1',
            target: { mode: 'NEW_TAB' as const },
        };
        const response = await askDatasetAi(request);
        expect(global.fetch).toHaveBeenCalledWith(
            `/datahub${AI_SERVICE_PATH}`,
            expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: JSON.stringify(request) }),
        );
        expect(response.sqlAction?.type).toBe('CREATE_TAB');
        expect(response.conversation.title).toBe(CONVERSATION.title);
        expect(response.assistantMessage.datasetUrn).toBe(DATASET_URN);
    });

    it('ignores actions that overwrite existing query tabs', async () => {
        global.fetch = vi
            .fn()
            .mockResolvedValue(responseWith({ ...RESPONSE, sqlAction: { type: 'UPDATE_TAB', statement: 'SELECT 2' } }));
        expect(
            (
                await askDatasetAi({
                    context: { datasetUrn: DATASET_URN },
                    question: 'Revise SQL',
                    target: { mode: 'NEW_TAB' },
                })
            ).sqlAction,
        ).toBeUndefined();
    });

    it('loads paginated conversations and their original dataset messages', async () => {
        global.fetch = vi
            .fn()
            .mockResolvedValueOnce(responseWith({ conversations: [CONVERSATION], nextOffset: 50 }))
            .mockResolvedValueOnce(responseWith({ conversation: CONVERSATION, messages: [MESSAGE], nextBefore: 1 }));
        expect((await listAiConversations()).nextOffset).toBe(50);
        const loaded = await loadAiConversation(CONVERSATION.id, 10);
        expect(loaded.messages?.[0]?.datasetUrn).toBe(DATASET_URN);
        expect(global.fetch).toHaveBeenLastCalledWith(
            `/datahub/ai-service/v1/conversations/${CONVERSATION.id}?before=10`,
            expect.objectContaining({ method: 'GET' }),
        );
    });

    it('renames and deletes saved conversations without parsing an empty delete response', async () => {
        global.fetch = vi
            .fn()
            .mockResolvedValueOnce(responseWith({ ...CONVERSATION, title: 'My analysis' }))
            .mockResolvedValueOnce(responseWith(undefined, true, 204));
        expect((await renameAiConversation(CONVERSATION.id, 'My analysis')).title).toBe('My analysis');
        await deleteAiConversation(CONVERSATION.id);
        expect(global.fetch).toHaveBeenLastCalledWith(
            `/datahub/ai-service/v1/conversations/${CONVERSATION.id}`,
            expect.objectContaining({ method: 'DELETE' }),
        );
    });

    it('surfaces safe errors and rejects malformed saved messages', async () => {
        global.fetch = vi
            .fn()
            .mockResolvedValueOnce(responseWith({ message: 'Dataset access denied', code: 'FORBIDDEN' }, false, 403))
            .mockResolvedValueOnce(responseWith({ conversation: CONVERSATION, messages: [{ role: 'assistant' }] }));
        await expect(listAiConversations()).rejects.toMatchObject({
            name: AskAiServiceError.name,
            status: 403,
            code: 'FORBIDDEN',
        });
        await expect(loadAiConversation(CONVERSATION.id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });
});
