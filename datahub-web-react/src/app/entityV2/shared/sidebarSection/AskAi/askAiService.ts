import {
    AskAiRequest,
    AskAiResponse,
    AskAiSource,
    AskAiSqlAction,
} from '@app/entityV2/shared/sidebarSection/AskAi/askAi.types';
import { resolveRuntimePath } from '@utils/runtimeBasePath';

export const AI_SERVICE_PATH = '/ai-service/v1/ask';
export const LOCAL_AI_SERVICE_PORT = 8091;

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

function normalizeResponse(value: unknown): AskAiResponse {
    if (
        !isRecord(value) ||
        typeof value.conversationId !== 'string' ||
        !value.conversationId ||
        typeof value.messageId !== 'string' ||
        !value.messageId ||
        typeof value.answer !== 'string'
    ) {
        throw new AskAiServiceError('The AI service returned an invalid response.', 502, 'INVALID_RESPONSE');
    }

    return {
        requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
        conversationId: value.conversationId,
        messageId: value.messageId,
        answer: value.answer,
        sqlAction: normalizeSqlAction(value.sqlAction),
        sources: Array.isArray(value.sources)
            ? value.sources.map(normalizeSource).filter((source): source is AskAiSource => source !== null)
            : [],
    };
}

function getServiceUrl(): string {
    if (
        typeof window !== 'undefined' &&
        (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ) {
        return `http://${window.location.hostname}:${LOCAL_AI_SERVICE_PORT}${AI_SERVICE_PATH}`;
    }
    return resolveRuntimePath(AI_SERVICE_PATH);
}

async function getErrorPayload(response: Response): Promise<ErrorPayload> {
    try {
        const payload: unknown = await response.json();
        return isRecord(payload) ? payload : {};
    } catch {
        return {};
    }
}

export async function askDatasetAi(request: AskAiRequest, signal?: AbortSignal): Promise<AskAiResponse> {
    const response = await fetch(getServiceUrl(), {
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
            `The AI service returned HTTP ${response.status}.`;
        throw new AskAiServiceError(
            message,
            response.status,
            typeof payload.code === 'string' ? payload.code : undefined,
        );
    }

    return normalizeResponse(await response.json());
}
