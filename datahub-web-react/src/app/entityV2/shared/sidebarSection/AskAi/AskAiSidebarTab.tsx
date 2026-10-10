import { Button, Loader, Text, TextArea } from '@components';
import { ArrowSquareOut } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { Copy } from '@phosphor-icons/react/dist/csr/Copy';
import { PaperPlaneTilt } from '@phosphor-icons/react/dist/csr/PaperPlaneTilt';
import React, { KeyboardEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styled from 'styled-components';

import { useEntityData, useRouteToTab } from '@app/entity/shared/EntityContext';
import { useAskAiConversation } from '@app/entityV2/shared/sidebarSection/AskAi/AskAiConversationContext';
import AskAiConversationControls from '@app/entityV2/shared/sidebarSection/AskAi/AskAiConversationControls';
import { AskAiMessage } from '@app/entityV2/shared/sidebarSection/AskAi/askAi.types';
import { useQueryWorkspace } from '@app/entityV2/shared/tabs/Dataset/Explore/QueryWorkspaceContext';
import { EntityTabProps } from '@app/entityV2/shared/types';

const SUGGESTION_KEYS = ['explain', 'preview', 'group'] as const;

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

export default function AskAiSidebarTab(_props: EntityTabProps) {
    const { t } = useTranslation('entity.profile.queries');
    const { t: entityTypesT } = useTranslation('entity.types');
    const { urn, entityData } = useEntityData();
    const routeToTab = useRouteToTab();
    const { workspace, canCreateTab, createTab, setActiveTab } = useQueryWorkspace();
    const chat = useAskAiConversation();
    const { messages, isAsking, initialize } = chat;
    const prompt = chat.draft;
    const setPrompt = chat.setDraft;
    const [actionError, setActionError] = useState<string | null>(null);
    const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
    const error = actionError || chat.error;
    useEffect(() => {
        initialize();
    }, [initialize]);

    const openExplore = (tabId: string) => {
        setActiveTab(tabId);
        routeToTab({ tabName: entityTypesT('tab.explore') });
    };

    const submitPrompt = async () => {
        const question = prompt.trim();
        if (!question || !urn || isAsking || chat.isLoading) return;
        setActionError(null);
        await chat.submit(question, urn);
    };

    const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submitPrompt();
        }
    };

    const createSqlTab = (message: AskAiMessage) => {
        const action = message.sqlAction;
        if (!action || !canCreateTab || message.datasetUrn !== urn) {
            setActionError(t('askAi.errors.tabLimit'));
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
            chat.updateMessage(message.id, { queryTabId: tab.id });
            openExplore(tab.id);
        }
    };

    const openMessageTab = (message: AskAiMessage) => {
        if (message.datasetUrn !== urn) {
            setActionError(t('askAi.errors.differentDataset'));
            return;
        }
        const existing = workspace.tabs.find((tab) => tab.sourceMessageId === message.id);
        if (existing) {
            openExplore(existing.id);
            return;
        }
        if (message.queryTabId && workspace.tabs.some((tab) => tab.id === message.queryTabId)) {
            openExplore(message.queryTabId);
            return;
        }
        createSqlTab(message);
    };

    const copySql = async (message: AskAiMessage) => {
        if (!message.sqlAction) {
            return;
        }
        await navigator.clipboard.writeText(message.sqlAction.statement);
        setCopiedMessageId(message.id);
        window.setTimeout(() => setCopiedMessageId(null), 1500);
    };

    return (
        <Panel>
            <AskAiConversationControls />
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
                        <Text size="xs">{t('askAi.datasetContext', { name: message.datasetName })}</Text>
                        <Text size="sm">{message.text}</Text>
                        {message.status === 'failed' && message.id === messages?.[messages.length - 1]?.id && (
                            <Button size="sm" variant="text" disabled={isAsking} onClick={() => chat.retry(message)}>
                                {t('askAi.history.retry')}
                            </Button>
                        )}
                        {message.requestId && <RequestId>{t('askAi.requestId', { id: message.requestId })}</RequestId>}
                        {message.sqlAction && (
                            <SqlCard>
                                <Text size="sm" weight="semiBold">
                                    {message.sqlAction.title}
                                </Text>
                                <SqlCode>{message.sqlAction.statement}</SqlCode>
                                {message.datasetUrn !== urn && (
                                    <Text size="xs">{t('askAi.errors.differentDataset')}</Text>
                                )}
                                <Actions>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        icon={{ icon: ArrowSquareOut }}
                                        disabled={message.datasetUrn !== urn}
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
                <Text size="xs">{t('askAi.currentDataset', { name: entityData?.name || urn })}</Text>
                <TextArea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={handlePromptKeyDown}
                    placeholder={t('askAi.placeholder')}
                    rows={3}
                    isDisabled={isAsking || chat.isLoading}
                    inputTestId="ask-ai-input"
                />
                <ComposerActions>
                    <Text size="xs">{t('askAi.submitHint')}</Text>
                    <Button
                        size="sm"
                        icon={{ icon: PaperPlaneTilt, weight: 'fill' }}
                        disabled={!prompt.trim() || !urn || isAsking || chat.isLoading}
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
