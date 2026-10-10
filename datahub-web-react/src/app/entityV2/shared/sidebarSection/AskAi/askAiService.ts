import {
    AskAiConversation,
    AskAiConversationDetail,
    AskAiConversationList,
    AskAiMessage,
    AskAiRequest,
    AskAiResponse,
    AskAiSource,
    AskAiSqlAction,
} from '@app/entityV2/shared/sidebarSection/AskAi/askAi.types';
import { resolveRuntimePath } from '@utils/runtimeBasePath';

export const AI_SERVICE_PATH = '/ai-service/v1/ask';
const SERVICE_ROOT = '/ai-service/v1';

type ErrorPayload = {
    message?: unknown;
    detail?: unknown;
    code?: unknown;
};

export class AskAiServiceError extends Error {
    status: number;

    code?: string;

    constructor(message: string, status: number, code?: string) {
        super(message);
        this.name = 'AskAiServiceError';
        this.status = status;
        this.code = code;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSource(value: unknown): AskAiSource | null {
    if (!isRecord(value) || typeof value.title !== 'string' || !value.title) {
        return null;
    }
    return {
        title: value.title,
        url: typeof value.url === 'string' ? value.url : undefined,
    };
}

function normalizeSqlAction(value: unknown): AskAiSqlAction | undefined {
    if (!isRecord(value) || value.type !== 'CREATE_TAB') {
        return undefined;
    }
    if (
        typeof value.title !== 'string' ||
        !value.title ||
        typeof value.statement !== 'string' ||
        !value.statement ||
        typeof value.dialect !== 'string' ||
        !value.dialect
    ) {
        return undefined;
    }
    return {
        type: 'CREATE_TAB',
        title: value.title,
        statement: value.statement,
        dialect: value.dialect,
    };
}

function invalidResponse(): never {
    throw new AskAiServiceError('The AI service returned an invalid response.', 502, 'INVALID_RESPONSE');
}

function normalizeConversation(value: unknown): AskAiConversation {
    if (
        !isRecord(value) ||
        typeof value.id !== 'string' ||
        !value.id ||
        typeof value.title !== 'string' ||
        typeof value.createdAt !== 'string' ||
        typeof value.updatedAt !== 'string'
    ) {
        return invalidResponse();
    }
    return { id: value.id, title: value.title, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

function normalizeSources(value: unknown): AskAiSource[] {
    return Array.isArray(value)
        ? value.map(normalizeSource).filter((source): source is AskAiSource => source !== null)
        : [];
}

function normalizeMessage(value: unknown): AskAiMessage {
    if (
        !isRecord(value) ||
        typeof value.id !== 'string' ||
        typeof value.sequence !== 'number' ||
        (value.role !== 'user' && value.role !== 'assistant') ||
        typeof value.text !== 'string' ||
        typeof value.datasetUrn !== 'string' ||
        typeof value.datasetName !== 'string' ||
        typeof value.createdAt !== 'string' ||
        typeof value.requestId !== 'string' ||
        (value.status !== 'pending' && value.status !== 'completed' && value.status !== 'failed')
    ) {
        return invalidResponse();
    }
    return {
        id: value.id,
        sequence: value.sequence,
        role: value.role,
        text: value.text,
        datasetUrn: value.datasetUrn,
        datasetName: value.datasetName,
        createdAt: value.createdAt,
        requestId: value.requestId,
        status: value.status,
        sqlAction: normalizeSqlAction(value.sqlAction),
        sources: normalizeSources(value.sources),
    };
}

function normalizeDetail(value: unknown): AskAiConversationDetail {
    if (!isRecord(value) || !Array.isArray(value.messages)) return invalidResponse();
    return {
        conversation: normalizeConversation(value.conversation),
        messages: value.messages.map(normalizeMessage),
        nextBefore: typeof value.nextBefore === 'number' ? value.nextBefore : null,
    };
}

function normalizeResponse(value: unknown): AskAiResponse {
    if (
        !isRecord(value) ||
        typeof value.conversationId !== 'string' ||
        !value.conversationId ||
        typeof value.messageId !== 'string' ||
        !value.messageId ||
        typeof value.answer !== 'string' ||
        typeof value.requestId !== 'string'
    )
        return invalidResponse();
    return {
        requestId: value.requestId,
        conversationId: value.conversationId,
        messageId: value.messageId,
        answer: value.answer,
        sqlAction: normalizeSqlAction(value.sqlAction),
        sources: normalizeSources(value.sources),
        conversation: normalizeConversation(value.conversation),
        userMessage: normalizeMessage(value.userMessage),
        assistantMessage: normalizeMessage(value.assistantMessage),
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

async function requestService(path: string, method = 'GET', body?: object, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(resolveRuntimePath(`${SERVICE_ROOT}${path}`), {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal,
    });
    if (!response.ok) {
        const payload = await getErrorPayload(response);
        const message =
            (typeof payload.message === 'string' && payload.message) ||
            (typeof payload.detail === 'string' && payload.detail) ||
            `The AI service returned HTTP ${response.status}.`;
        throw new AskAiServiceError(
            message,
            response.status,
            typeof payload.code === 'string' ? payload.code : undefined,
        );
    }
    return response.status === 204 ? undefined : response.json();
}

export async function askDatasetAi(request: AskAiRequest, signal?: AbortSignal): Promise<AskAiResponse> {
    return normalizeResponse(await requestService('/ask', 'POST', request, signal));
}

export async function listAiConversations(offset = 0, signal?: AbortSignal): Promise<AskAiConversationList> {
    const value = await requestService(`/conversations?offset=${offset}`, 'GET', undefined, signal);
    if (!isRecord(value) || !Array.isArray(value.conversations)) return invalidResponse();
    return {
        conversations: value.conversations.map(normalizeConversation),
        nextOffset: typeof value.nextOffset === 'number' ? value.nextOffset : null,
    };
}

export async function createAiConversation(signal?: AbortSignal): Promise<AskAiConversation> {
    return normalizeConversation(await requestService('/conversations', 'POST', {}, signal));
}

export async function loadAiConversation(
    id: string,
    before?: number,
    signal?: AbortSignal,
): Promise<AskAiConversationDetail> {
    return normalizeDetail(
        await requestService(
            `/conversations/${encodeURIComponent(id)}${before ? `?before=${before}` : ''}`,
            'GET',
            undefined,
            signal,
        ),
    );
}

export async function renameAiConversation(id: string, title: string): Promise<AskAiConversation> {
    return normalizeConversation(await requestService(`/conversations/${encodeURIComponent(id)}`, 'PATCH', { title }));
}

export async function deleteAiConversation(id: string): Promise<void> {
    await requestService(`/conversations/${encodeURIComponent(id)}`, 'DELETE');
}

export async function clearAiConversations(): Promise<void> {
    await requestService('/conversations', 'DELETE');
}
