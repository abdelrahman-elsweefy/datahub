import React, { ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { useUserContext } from '@app/context/useUserContext';
import { AskAiConversationContext } from '@app/entityV2/shared/sidebarSection/AskAi/AskAiConversationContext';
import { AskAiConversation, AskAiMessage, AskAiRequest } from '@app/entityV2/shared/sidebarSection/AskAi/askAi.types';
import {
    askDatasetAi,
    clearAiConversations,
    createAiConversation,
    deleteAiConversation,
    listAiConversations,
    loadAiConversation,
    renameAiConversation,
} from '@app/entityV2/shared/sidebarSection/AskAi/askAiService';

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'The assistant request could not be completed.';
}

function storageKey(userUrn: string): string {
    return `datahub.askAi.activeConversation.${userUrn}`;
}

function rememberSelection(userUrn: string, id: string | null): void {
    try {
        window.sessionStorage.setItem(storageKey(userUrn), id || '');
    } catch {
        /* Backend history remains available without browser storage. */
    }
}

function rememberedSelection(userUrn: string): string | null {
    try {
        return window.sessionStorage.getItem(storageKey(userUrn));
    } catch {
        return null;
    }
}

type Props = { children: ReactNode };

function ConversationStateProvider({ children, userUrn }: Props & { userUrn: string }) {
    const [draft, setDraft] = useState('');
    const [conversation, setConversation] = useState<AskAiConversation | null>(null);
    const [conversations, setConversations] = useState<AskAiConversation[]>([]);
    const [messages, setMessages] = useState<AskAiMessage[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [pendingId, setPendingId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [nextBefore, setNextBefore] = useState<number | null>(null);
    const [nextOffset, setNextOffset] = useState<number | null>(null);
    const activeId = useRef<string | null>(null);
    const selectionVersion = useRef(0);
    const initialized = useRef(false);
    const replyController = useRef<AbortController | null>(null);
    const lifecycleController = useRef(new AbortController());
    const pendingRequest = useRef(false);
    const deletedIds = useRef(new Set<string>());
    const historyVersion = useRef(0);

    useEffect(
        () => () => {
            lifecycleController.current.abort();
            replyController.current?.abort();
        },
        [],
    );

    const upsert = useCallback((item: AskAiConversation) => {
        setConversations((current) =>
            [item, ...current.filter((entry) => entry.id !== item.id)].sort((a, b) =>
                b.updatedAt.localeCompare(a.updatedAt),
            ),
        );
    }, []);

    const selectConversation = useCallback(
        async (id: string): Promise<void> => {
            const version = ++selectionVersion.current;
            activeId.current = id;
            setConversation(null);
            setMessages([]);
            setDraft('');
            setError(null);
            setIsLoading(true);
            try {
                const detail = await loadAiConversation(id, undefined, lifecycleController.current.signal);
                if (version !== selectionVersion.current) return;
                setConversation(detail.conversation);
                setMessages(detail.messages);
                setNextBefore(detail.nextBefore);
                rememberSelection(userUrn, id);
                upsert(detail.conversation);
            } catch (failure) {
                if (version === selectionVersion.current) {
                    activeId.current = null;
                    setError(errorMessage(failure));
                }
            } finally {
                if (version === selectionVersion.current) setIsLoading(false);
            }
        },
        [userUrn, upsert],
    );

    const initialize = useCallback(async (): Promise<void> => {
        if (initialized.current || !userUrn) return;
        initialized.current = true;
        const version = selectionVersion.current;
        setIsLoading(true);
        try {
            const list = await listAiConversations(0, lifecycleController.current.signal);
            setConversations(list.conversations);
            setNextOffset(list.nextOffset);
            if (version !== selectionVersion.current) return;
            const remembered = rememberedSelection(userUrn);
            const selected = remembered === '' ? undefined : remembered || list.conversations?.[0]?.id;
            if (selected) await selectConversation(selected);
        } catch (failure) {
            initialized.current = false;
            if (version === selectionVersion.current) setError(errorMessage(failure));
        } finally {
            if (version === selectionVersion.current) setIsLoading(false);
        }
    }, [userUrn, selectConversation]);

    const newChat = (): void => {
        ++selectionVersion.current;
        activeId.current = null;
        setConversation(null);
        setMessages([]);
        setDraft('');
        setNextBefore(null);
        setError(null);
        setIsLoading(false);
        rememberSelection(userUrn, null);
    };

    const runRequest = async (request: AskAiRequest, optimistic?: AskAiMessage): Promise<boolean> => {
        if (pendingRequest.current) return false;
        pendingRequest.current = true;
        const version = selectionVersion.current;
        const historyEpoch = historyVersion.current;
        const controller = new AbortController();
        replyController.current = controller;
        setError(null);
        try {
            let id = request.conversationId;
            if (!id) {
                setIsLoading(true);
                const created = await createAiConversation(controller.signal);
                id = created.id;
                request.conversationId = id;
                upsert(created);
                if (version === selectionVersion.current) {
                    activeId.current = id;
                    setConversation(created);
                    rememberSelection(userUrn, id);
                }
            }
            setPendingId(id);
            if (version === selectionVersion.current) {
                setIsLoading(false);
                if (optimistic) setMessages((current) => [...current, optimistic]);
                else
                    setMessages((current) =>
                        current.map((message) =>
                            message.requestId === request.requestId ? { ...message, status: 'pending' } : message,
                        ),
                    );
            }
            const result = await askDatasetAi(request, controller.signal);
            if (historyEpoch !== historyVersion.current || deletedIds.current.has(result.conversation.id)) return false;
            upsert(result.conversation);
            if (activeId.current === id) {
                setConversation(result.conversation);
                setMessages((current) => [
                    ...current.filter((message) => message.requestId !== result.requestId),
                    result.userMessage,
                    result.assistantMessage,
                ]);
            }
            return true;
        } catch (failure) {
            if (controller.signal.aborted) return false;
            if (version === selectionVersion.current) {
                setError(errorMessage(failure));
                setMessages((current) =>
                    current.map((message) =>
                        message.requestId === request.requestId ? { ...message, status: 'failed' } : message,
                    ),
                );
            }
            return false;
        } finally {
            pendingRequest.current = false;
            setPendingId(null);
            replyController.current = null;
            if (version === selectionVersion.current) setIsLoading(false);
        }
    };

    const submit = async (question: string, datasetUrn: string): Promise<boolean> => {
        if (!question.trim() || !userUrn) return false;
        const version = selectionVersion.current;
        const requestId = crypto.randomUUID();
        const optimistic: AskAiMessage = {
            id: requestId,
            sequence: 0,
            role: 'user',
            text: question.trim(),
            datasetUrn,
            datasetName: datasetUrn,
            createdAt: new Date().toISOString(),
            requestId,
            status: 'pending',
            sources: [],
        };
        const completed = await runRequest(
            {
                context: { datasetUrn },
                question: question.trim(),
                conversationId: activeId.current,
                requestId,
                target: { mode: 'NEW_TAB' },
            },
            optimistic,
        );
        if (completed && version === selectionVersion.current) {
            setDraft((current) => (current.trim() === question.trim() ? '' : current));
        }
        return completed;
    };

    const retry = async (message: AskAiMessage): Promise<void> => {
        if (!activeId.current) return;
        await runRequest({
            context: { datasetUrn: message.datasetUrn },
            question: message.text,
            conversationId: activeId.current,
            requestId: message.requestId,
            target: { mode: 'NEW_TAB' },
        });
    };

    const loadOlderMessages = async (): Promise<void> => {
        if (!activeId.current || nextBefore === null) return;
        const id = activeId.current;
        const version = selectionVersion.current;
        setIsLoading(true);
        try {
            const detail = await loadAiConversation(id, nextBefore, lifecycleController.current.signal);
            if (version !== selectionVersion.current) return;
            setMessages((current) => [
                ...detail.messages,
                ...current.filter((message) => !detail.messages.some((older) => older.id === message.id)),
            ]);
            setNextBefore(detail.nextBefore);
        } catch (failure) {
            if (version === selectionVersion.current) setError(errorMessage(failure));
        } finally {
            if (version === selectionVersion.current) setIsLoading(false);
        }
    };

    const loadMoreConversations = async (): Promise<void> => {
        if (nextOffset === null) return;
        try {
            const list = await listAiConversations(nextOffset, lifecycleController.current.signal);
            setConversations((current) => [
                ...current,
                ...list.conversations.filter((item) => !current.some((entry) => entry.id === item.id)),
            ]);
            setNextOffset(list.nextOffset);
        } catch (failure) {
            setError(errorMessage(failure));
        }
    };

    const rename = async (title: string): Promise<void> => {
        const id = activeId.current;
        if (!id || !title.trim()) return;
        try {
            const updated = await renameAiConversation(id, title.trim());
            upsert(updated);
            if (activeId.current === id) setConversation(updated);
        } catch (failure) {
            setError(errorMessage(failure));
        }
    };

    const deleteCurrent = async (): Promise<void> => {
        const id = activeId.current;
        if (!id) return;
        try {
            await deleteAiConversation(id);
            deletedIds.current.add(id);
            if (pendingId === id) replyController.current?.abort();
            setConversations((current) => current.filter((item) => item.id !== id));
            if (activeId.current === id) newChat();
        } catch (failure) {
            setError(errorMessage(failure));
        }
    };

    const clearHistory = async (): Promise<void> => {
        try {
            await clearAiConversations();
            ++historyVersion.current;
            replyController.current?.abort();
            setConversations([]);
            setNextOffset(null);
            newChat();
        } catch (failure) {
            setError(errorMessage(failure));
        }
    };

    const updateMessage = (id: string, update: Partial<AskAiMessage>): void => {
        setMessages((current) => current.map((message) => (message.id === id ? { ...message, ...update } : message)));
    };

    const remotePending = messages.some((message) => message.status === 'pending');
    useEffect(() => {
        const id = activeId.current;
        if (!id || !remotePending || pendingId === id) return undefined;
        const timer = window.setTimeout(() => {
            loadAiConversation(id, undefined, lifecycleController.current.signal)
                .then((detail) => {
                    if (activeId.current !== id) return;
                    setConversation(detail.conversation);
                    setMessages(detail.messages);
                    setNextBefore(detail.nextBefore);
                    upsert(detail.conversation);
                })
                .catch((failure: unknown) => {
                    if (activeId.current === id) setError(errorMessage(failure));
                });
        }, 2000);
        return () => window.clearTimeout(timer);
    }, [messages, remotePending, pendingId, upsert]);

    return (
        <AskAiConversationContext.Provider
            value={{
                draft,
                setDraft,
                conversation,
                conversations,
                messages,
                isLoading,
                isAsking: pendingId !== null || remotePending,
                error,
                hasOlderMessages: nextBefore !== null,
                hasMoreConversations: nextOffset !== null,
                initialize,
                selectConversation,
                loadOlderMessages,
                loadMoreConversations,
                newChat,
                submit,
                retry,
                rename,
                deleteCurrent,
                clearHistory,
                updateMessage,
            }}
        >
            {children}
        </AskAiConversationContext.Provider>
    );
}

export default function AskAiConversationProvider({ children }: Props) {
    const userContext = useUserContext();
    const userUrn = userContext.user?.urn || userContext.urn || '';
    return (
        <ConversationStateProvider key={userUrn} userUrn={userUrn}>
            {children}
        </ConversationStateProvider>
    );
}
