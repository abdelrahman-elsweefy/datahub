import { Button, Text } from '@components';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import styled from 'styled-components';

import { useAskAiConversation } from '@app/entityV2/shared/sidebarSection/AskAi/AskAiConversationContext';

const Controls = styled.div`
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid ${(props) => props.theme.colors.border};
`;
const Select = styled.select`
    width: 100%;
    padding: 8px;
    border: 1px solid ${(props) => props.theme.colors.border};
    border-radius: 6px;
    background: ${(props) => props.theme.colors.bgSurface};
    color: ${(props) => props.theme.colors.text};
    font: inherit;
`;
const TitleInput = styled.input`
    min-width: 0;
    width: 100%;
    padding: 8px;
    border: 1px solid ${(props) => props.theme.colors.border};
    border-radius: 6px;
    background: ${(props) => props.theme.colors.bgSurface};
    color: ${(props) => props.theme.colors.text};
    font: inherit;
`;
const Actions = styled.div`
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
`;

export default function AskAiConversationControls() {
    const { t } = useTranslation('entity.profile.queries');
    const chat = useAskAiConversation();
    const [title, setTitle] = useState<string | null>(null);
    const [confirmation, setConfirmation] = useState<'delete' | 'clear' | null>(null);
    const reset = (): void => {
        setTitle(null);
        setConfirmation(null);
    };
    return (
        <Controls>
            <Select
                aria-label={t('askAi.history.saved')}
                value={chat.conversation?.id || ''}
                disabled={chat.isLoading}
                onChange={(event) => {
                    reset();
                    if (event.target.value) chat.selectConversation(event.target.value);
                    else chat.newChat();
                }}
            >
                <option value="">{t('askAi.history.newChat')}</option>
                {chat.conversations.map((conversation) => (
                    <option key={conversation.id} value={conversation.id}>
                        {conversation.title}
                    </option>
                ))}
            </Select>
            {chat.hasMoreConversations && (
                <Button size="sm" variant="text" onClick={chat.loadMoreConversations}>
                    {t('askAi.history.loadMore')}
                </Button>
            )}
            {title !== null ? (
                <>
                    <TitleInput
                        aria-label={t('askAi.history.title')}
                        maxLength={120}
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                    />
                    <Actions>
                        <Button
                            size="sm"
                            disabled={!title.trim()}
                            onClick={async () => {
                                await chat.rename(title);
                                setTitle(null);
                            }}
                        >
                            {t('askAi.history.saveTitle')}
                        </Button>
                        <Button size="sm" variant="text" onClick={reset}>
                            {t('askAi.history.cancel')}
                        </Button>
                    </Actions>
                </>
            ) : (
                <Actions>
                    <Button
                        size="sm"
                        variant="text"
                        disabled={chat.isLoading}
                        onClick={() => {
                            reset();
                            chat.newChat();
                        }}
                    >
                        {t('askAi.history.newChat')}
                    </Button>
                    {chat.conversation && (
                        <>
                            <Button
                                size="sm"
                                variant="text"
                                onClick={() => {
                                    setTitle(chat.conversation?.title || '');
                                    setConfirmation(null);
                                }}
                            >
                                {t('askAi.history.rename')}
                            </Button>
                            <Button size="sm" variant="text" onClick={() => setConfirmation('delete')}>
                                {t('askAi.history.delete')}
                            </Button>
                        </>
                    )}
                    {chat.conversations.length > 0 && (
                        <Button size="sm" variant="text" onClick={() => setConfirmation('clear')}>
                            {t('askAi.history.clearAll')}
                        </Button>
                    )}
                </Actions>
            )}
            {confirmation && (
                <>
                    <Text size="sm">
                        {t(confirmation === 'delete' ? 'askAi.history.confirmDelete' : 'askAi.history.confirmClear')}
                    </Text>
                    <Actions>
                        <Button
                            size="sm"
                            onClick={async () => {
                                if (confirmation === 'delete') await chat.deleteCurrent();
                                else await chat.clearHistory();
                                reset();
                            }}
                        >
                            {t('askAi.history.confirm')}
                        </Button>
                        <Button size="sm" variant="text" onClick={reset}>
                            {t('askAi.history.cancel')}
                        </Button>
                    </Actions>
                </>
            )}
        </Controls>
    );
}
