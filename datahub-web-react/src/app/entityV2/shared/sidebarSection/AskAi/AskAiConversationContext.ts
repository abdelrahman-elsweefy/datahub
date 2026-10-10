import { createContext, useContext } from 'react';

import { AskAiConversation, AskAiMessage } from '@app/entityV2/shared/sidebarSection/AskAi/askAi.types';

export type AskAiConversationContextValue = {
    draft: string;
    setDraft: (value: string) => void;
    conversation: AskAiConversation | null;
    conversations: AskAiConversation[];
    messages: AskAiMessage[];
    isLoading: boolean;
    isAsking: boolean;
    error: string | null;
    hasOlderMessages: boolean;
    hasMoreConversations: boolean;
    initialize: () => Promise<void>;
    selectConversation: (id: string) => Promise<void>;
    loadOlderMessages: () => Promise<void>;
    loadMoreConversations: () => Promise<void>;
    newChat: () => void;
    submit: (question: string, datasetUrn: string) => Promise<boolean>;
    retry: (message: AskAiMessage) => Promise<void>;
    rename: (title: string) => Promise<void>;
    deleteCurrent: () => Promise<void>;
    clearHistory: () => Promise<void>;
    updateMessage: (id: string, update: Partial<AskAiMessage>) => void;
};

export const AskAiConversationContext = createContext<AskAiConversationContextValue | null>(null);

export function useAskAiConversation(): AskAiConversationContextValue {
    const context = useContext(AskAiConversationContext);
    if (!context) throw new Error('Ask AI requires a conversation provider');
    return context;
}
