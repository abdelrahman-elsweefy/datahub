import { MockedProvider } from '@apollo/client/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAskAiConversation } from '@app/entityV2/shared/sidebarSection/AskAi/AskAiConversationContext';
import AskAiConversationProvider from '@app/entityV2/shared/sidebarSection/AskAi/AskAiConversationProvider';
import { AskAiConversation, AskAiMessage, AskAiResponse } from '@app/entityV2/shared/sidebarSection/AskAi/askAi.types';
import {
    askDatasetAi,
    clearAiConversations,
    createAiConversation,
    deleteAiConversation,
    listAiConversations,
    loadAiConversation,
    renameAiConversation,
} from '@app/entityV2/shared/sidebarSection/AskAi/askAiService';
import TestPageContainer from '@utils/test-utils/TestPageContainer';

const { user } = vi.hoisted(() => ({ user: { urn: 'urn:li:corpuser:user1' } }));
vi.mock('@app/context/useUserContext', () => ({ useUserContext: () => ({ user }) }));
vi.mock('@app/entityV2/shared/sidebarSection/AskAi/askAiService');

const DATASET_A = 'urn:li:dataset:(urn:li:dataPlatform:postgres,my_db.my_schema.events,PROD)';
const DATASET_B = 'urn:li:dataset:(urn:li:dataPlatform:postgres,my_db.my_schema.customers,PROD)';
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
    text: 'Saved answer',
    datasetUrn: DATASET_A,
    datasetName: 'events',
    createdAt: '2026-01-01',
    requestId: 'request-1',
    status: 'completed',
    sources: [],
};

function reply(datasetUrn: string, requestId: string): AskAiResponse {
    const assistantMessage = { ...MESSAGE, id: `answer-${requestId}`, requestId, datasetUrn };
    return {
        requestId,
        conversationId: CONVERSATION.id,
        messageId: assistantMessage.id,
        answer: assistantMessage.text,
        sources: [],
        conversation: CONVERSATION,
        userMessage: { ...assistantMessage, id: `user-${requestId}`, role: 'user', text: 'Explain this dataset' },
        assistantMessage,
    };
}

function Panel({ datasetUrn }: { datasetUrn: string }) {
    const chat = useAskAiConversation();
    const { initialize } = chat;
    useEffect(() => {
        initialize();
    }, [initialize]);
    return (
        <>
            <span data-testid="messages">{chat.messages.map((message) => message.text).join('|')}</span>
            <span data-testid="title">{chat.conversation?.title}</span>
            <span data-testid="history">{chat.conversations.length}</span>
            <button type="button" onClick={() => chat.submit('Explain this dataset', datasetUrn)}>
                Send
            </button>
            <button type="button" onClick={() => chat.rename('My analysis')}>
                Rename
            </button>
            <button type="button" onClick={chat.newChat}>
                New chat
            </button>
            <button type="button" onClick={chat.deleteCurrent}>
                Delete
            </button>
            <button type="button" onClick={chat.clearHistory}>
                Clear
            </button>
        </>
    );
}

function Page({ datasetUrn }: { datasetUrn: string }) {
    return (
        <MockedProvider>
            <TestPageContainer>
                <AskAiConversationProvider>
                    <Panel key={datasetUrn} datasetUrn={datasetUrn} />
                </AskAiConversationProvider>
            </TestPageContainer>
        </MockedProvider>
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    user.urn = 'urn:li:corpuser:user1';
    vi.mocked(listAiConversations).mockResolvedValue({ conversations: [], nextOffset: null });
    vi.mocked(createAiConversation).mockResolvedValue(CONVERSATION);
    vi.mocked(loadAiConversation).mockResolvedValue({
        conversation: CONVERSATION,
        messages: [MESSAGE],
        nextBefore: null,
    });
    vi.mocked(renameAiConversation).mockResolvedValue({ ...CONVERSATION, title: 'My analysis' });
    vi.mocked(deleteAiConversation).mockResolvedValue(undefined);
    vi.mocked(clearAiConversations).mockResolvedValue(undefined);
    vi.mocked(askDatasetAi).mockImplementation(async (request) =>
        reply(request.context.datasetUrn, request.requestId || 'request-1'),
    );
});

describe('saved Ask AI conversations', () => {
    it('preserves a pending reply when the dataset panel unmounts and continues the same conversation', async () => {
        let complete: ((value: AskAiResponse) => void) | undefined;
        vi.mocked(askDatasetAi).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    complete = resolve;
                }),
        );
        const page = render(<Page datasetUrn={DATASET_A} />);
        await waitFor(() => expect(listAiConversations).toHaveBeenCalled());
        fireEvent.click(screen.getByText('Send'));
        await waitFor(() => expect(askDatasetAi).toHaveBeenCalledTimes(1));
        const firstRequest = vi.mocked(askDatasetAi).mock.calls?.[0]?.[0];
        page.rerender(<Page datasetUrn={DATASET_B} />);
        expect(screen.getByTestId('messages').textContent).toContain('Explain this dataset');
        await act(async () => {
            complete?.(reply(DATASET_A, firstRequest?.requestId || 'request-1'));
        });
        await waitFor(() => expect(screen.getByTestId('messages').textContent).toContain('Saved answer'));
        fireEvent.click(screen.getByText('Send'));
        await waitFor(() => expect(askDatasetAi).toHaveBeenCalledTimes(2));
        expect(vi.mocked(askDatasetAi).mock.calls?.[1]?.[0]).toMatchObject({
            conversationId: CONVERSATION.id,
            context: { datasetUrn: DATASET_B },
        });
        expect(createAiConversation).toHaveBeenCalledTimes(1);
    });

    it('restores titled backend history after a refresh and saves renames', async () => {
        vi.mocked(listAiConversations).mockResolvedValue({ conversations: [CONVERSATION], nextOffset: null });
        render(<Page datasetUrn={DATASET_B} />);
        await waitFor(() => expect(screen.getByTestId('messages').textContent).toContain('Saved answer'));
        expect(screen.getByTestId('title').textContent).toBe(CONVERSATION.title);
        fireEvent.click(screen.getByText('Rename'));
        await waitFor(() => expect(screen.getByTestId('title').textContent).toBe('My analysis'));
        expect(renameAiConversation).toHaveBeenCalledWith(CONVERSATION.id, 'My analysis');
    });

    it('keeps previous history for new chats and clears it only after backend deletion succeeds', async () => {
        vi.mocked(listAiConversations).mockResolvedValue({ conversations: [CONVERSATION], nextOffset: null });
        render(<Page datasetUrn={DATASET_A} />);
        await waitFor(() => expect(screen.getByTestId('messages').textContent).toContain('Saved answer'));
        fireEvent.click(screen.getByText('New chat'));
        expect(screen.getByTestId('messages').textContent).toBe('');
        expect(screen.getByTestId('history').textContent).toBe('1');
        expect(deleteAiConversation).not.toHaveBeenCalled();
        fireEvent.click(screen.getByText('Clear'));
        await waitFor(() => expect(screen.getByTestId('history').textContent).toBe('0'));
        expect(clearAiConversations).toHaveBeenCalledTimes(1);
    });

    it('clears in-memory history when the authenticated user changes', async () => {
        vi.mocked(listAiConversations)
            .mockResolvedValueOnce({ conversations: [CONVERSATION], nextOffset: null })
            .mockResolvedValue({ conversations: [], nextOffset: null });
        const page = render(<Page datasetUrn={DATASET_A} />);
        await waitFor(() => expect(screen.getByTestId('messages').textContent).toContain('Saved answer'));
        user.urn = 'urn:li:corpuser:user2';
        page.rerender(<Page datasetUrn={DATASET_A} />);
        await waitFor(() => expect(screen.getByTestId('messages').textContent).toBe(''));
        expect(screen.getByTestId('history').textContent).toBe('0');
    });
});
