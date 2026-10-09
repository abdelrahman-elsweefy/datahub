import { Button, Loader, Text, TextArea } from '@components';
import { ArrowSquareOut } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { Copy } from '@phosphor-icons/react/dist/csr/Copy';
import { PaperPlaneTilt } from '@phosphor-icons/react/dist/csr/PaperPlaneTilt';
import React, { KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styled from 'styled-components';

import { useUserContext } from '@app/context/useUserContext';
import { useEntityData, useRouteToTab } from '@app/entity/shared/EntityContext';
import { AskAiSqlAction } from '@app/entityV2/shared/sidebarSection/AskAi/askAi.types';
import { AskAiServiceError, askDatasetAi } from '@app/entityV2/shared/sidebarSection/AskAi/askAiService';
import { useQueryWorkspace } from '@app/entityV2/shared/tabs/Dataset/Explore/QueryWorkspaceContext';
import { EntityTabProps } from '@app/entityV2/shared/types';

const SUGGESTION_KEYS = ['explain', 'preview', 'group'] as const;

type ConversationMessage = {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    requestId?: string;
    sqlAction?: AskAiSqlAction;
    queryTabId?: string;
};

const Panel = styled.div`
    display: flex;
    min-height: 100%;
    flex-direction: column;
    background: ${(props) => props.theme.colors.bg};
`;

const Messages = styled.div`
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
`;

const Suggestions = styled.div`
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 8px;
`;

const SuggestionButton = styled.button`
    padding: 10px 12px;
    border: 1px solid ${(props) => props.theme.colors.border};
    border-radius: 8px;
    background: ${(props) => props.theme.colors.bgSurface};
    color: ${(props) => props.theme.colors.text};
    cursor: pointer;
    font: inherit;
    overflow-wrap: anywhere;
    text-align: left;
    white-space: normal;

    &:hover {
        background: ${(props) => props.theme.colors.bgHover};
    }
`;

const Message = styled.div<{ $role: 'user' | 'assistant' }>`
    display: flex;
    max-width: 92%;
    flex-direction: column;
    align-self: ${(props) => (props.$role === 'user' ? 'flex-end' : 'flex-start')};
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid ${(props) => props.theme.colors.border};
    border-radius: 10px;
    background: ${(props) =>
        props.$role === 'user' ? props.theme.colors.bgSelectedSubtle : props.theme.colors.bgSurface};
    overflow-wrap: anywhere;
    white-space: pre-wrap;
`;

const SqlCard = styled.div`
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border: 1px solid ${(props) => props.theme.colors.border};
    border-radius: 8px;
    background: ${(props) => props.theme.colors.bg};
`;

const SqlCode = styled.pre`
    max-height: 220px;
    margin: 0;
    overflow: auto;
    color: ${(props) => props.theme.colors.text};
    font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
`;

const Actions = styled.div`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
`;

const ErrorMessage = styled.div`
    margin: 0 16px 12px;
    padding: 10px 12px;
    border: 1px solid ${(props) => props.theme.colors.borderError};
    border-radius: 8px;
    background: ${(props) => props.theme.colors.bgSurfaceError};
    color: ${(props) => props.theme.colors.text};
`;

const Composer = styled.div`
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 16px 16px;
    border-top: 1px solid ${(props) => props.theme.colors.border};
    background: ${(props) => props.theme.colors.bgSurface};
`;

const ComposerActions = styled.div`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
`;

const LoadingRow = styled.div`
    display: flex;
    align-items: center;
    gap: 8px;
`;

const RequestId = styled.span`
    color: ${(props) => props.theme.colors.textTertiary};
    font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 10px;
`;

function getServiceErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof AskAiServiceError || error instanceof Error) {
        return error.message;
    }
    return fallback;
}

export default function AskAiSidebarTab(_props: EntityTabProps) {
    const { t } = useTranslation('entity.profile.queries');
    const { t: entityTypesT } = useTranslation('entity.types');
    const { urn } = useEntityData();
    const routeToTab = useRouteToTab();
    const userContext = useUserContext();
    const { workspace, canCreateTab, createTab, setActiveTab } = useQueryWorkspace();
    const abortController = useRef<AbortController | null>(null);
    const [prompt, setPrompt] = useState('');
    const [conversationId, setConversationId] = useState<string | null>(null);
    const [messages, setMessages] = useState<ConversationMessage[]>([]);
    const [isAsking, setIsAsking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

    const userUrn = userContext.user?.urn || userContext.urn || '';
    useEffect(
        () => () => {
            abortController.current?.abort();
        },
        [],
    );

    const openExplore = (tabId: string) => {
        setActiveTab(tabId);
        routeToTab({ tabName: entityTypesT('tab.explore') });
    };

    const submitPrompt = async () => {
        const question = prompt.trim();
        if (!question || !urn || !userUrn || isAsking) {
            return;
        }

        const userMessageId = `user-${Date.now()}`;
        setMessages((current) => [...current, { id: userMessageId, role: 'user', text: question }]);
        setIsAsking(true);
        setError(null);
        abortController.current?.abort();
        const controller = new AbortController();
        abortController.current = controller;

        try {
            const response = await askDatasetAi(
                {
                    context: { datasetUrn: urn, userUrn },
                    question,
                    conversationId,
                    target: { mode: 'NEW_TAB' },
                },
                controller.signal,
            );
            setConversationId(response.conversationId);
            setPrompt('');

            setMessages((current) => [
                ...current,
                {
                    id: response.messageId,
                    role: 'assistant',
                    text: response.answer,
                    requestId: response.requestId,
                    sqlAction: response.sqlAction,
                },
            ]);
        } catch (requestError) {
            if (requestError instanceof DOMException && requestError.name === 'AbortError') {
                return;
            }
            setError(getServiceErrorMessage(requestError, t('askAi.errors.unexpected')));
        } finally {
            if (abortController.current === controller) {
                abortController.current = null;
                setIsAsking(false);
            }
        }
    };

    const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submitPrompt();
        }
    };

    const updateMessage = (messageId: string, update: Partial<ConversationMessage>) => {
        setMessages((current) =>
            current.map((message) => (message.id === messageId ? { ...message, ...update } : message)),
        );
    };

    const createSqlTab = (message: ConversationMessage) => {
        const action = message.sqlAction;
        if (!action || !canCreateTab) {
            setError(t('askAi.errors.tabLimit'));
            return;
        }
        const tab = createTab({
            title: action.title,
            sql: action.statement,
            dialect: action.dialect,
            source: 'ai',
            sourceMessageId: message.id,
            isDirty: true,
        });
        if (tab) {
            updateMessage(message.id, { queryTabId: tab.id });
            openExplore(tab.id);
        }
    };

    const openMessageTab = (message: ConversationMessage) => {
        if (message.queryTabId && workspace.tabs.some((tab) => tab.id === message.queryTabId)) {
            openExplore(message.queryTabId);
            return;
        }
        createSqlTab(message);
    };

    const copySql = async (message: ConversationMessage) => {
        if (!message.sqlAction) {
            return;
        }
        await navigator.clipboard.writeText(message.sqlAction.statement);
        setCopiedMessageId(message.id);
        window.setTimeout(() => setCopiedMessageId(null), 1500);
    };

    return (
        <Panel>
            <Messages aria-live="polite">
                {messages.length === 0 && (
                    <Suggestions>
                        <Text weight="semiBold">{t('askAi.suggestions.title')}</Text>
                        {SUGGESTION_KEYS.map((suggestion) => (
                            <SuggestionButton
                                key={suggestion}
                                type="button"
                                onClick={() => setPrompt(t(`askAi.suggestions.${suggestion}`))}
                            >
                                {t(`askAi.suggestions.${suggestion}`)}
                            </SuggestionButton>
                        ))}
                    </Suggestions>
                )}
                {messages.map((message) => (
                    <Message key={message.id} $role={message.role}>
                        <Text size="sm">{message.text}</Text>
                        {message.requestId && <RequestId>{t('askAi.requestId', { id: message.requestId })}</RequestId>}
                        {message.sqlAction && (
                            <SqlCard>
                                <Text size="sm" weight="semiBold">
                                    {message.sqlAction.title}
                                </Text>
                                <SqlCode>{message.sqlAction.statement}</SqlCode>
                                <Actions>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        icon={{ icon: ArrowSquareOut }}
                                        onClick={() => openMessageTab(message)}
                                    >
                                        {t('askAi.actions.openExplore')}
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="text"
                                        icon={{ icon: Copy }}
                                        onClick={() => copySql(message)}
                                    >
                                        {copiedMessageId === message.id
                                            ? t('askAi.actions.copied')
                                            : t('askAi.actions.copy')}
                                    </Button>
                                </Actions>
                            </SqlCard>
                        )}
                    </Message>
                ))}
                {isAsking && (
                    <LoadingRow>
                        <Loader size="sm" />
                        <Text size="sm">{t('askAi.thinking')}</Text>
                    </LoadingRow>
                )}
            </Messages>
            {error && (
                <ErrorMessage role="alert">
                    <Text size="sm">{error}</Text>
                </ErrorMessage>
            )}
            <Composer>
                <TextArea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={handlePromptKeyDown}
                    placeholder={t('askAi.placeholder')}
                    rows={3}
                    isDisabled={isAsking}
                    inputTestId="ask-ai-input"
                />
                <ComposerActions>
                    <Text size="xs">{t('askAi.submitHint')}</Text>
                    <Button
                        size="sm"
                        icon={{ icon: PaperPlaneTilt, weight: 'fill' }}
                        disabled={!prompt.trim() || !urn || !userUrn || isAsking}
                        isLoading={isAsking}
                        onClick={submitPrompt}
                        data-testid="ask-ai-submit"
                    >
                        {t('askAi.ask')}
                    </Button>
                </ComposerActions>
            </Composer>
        </Panel>
    );
}
