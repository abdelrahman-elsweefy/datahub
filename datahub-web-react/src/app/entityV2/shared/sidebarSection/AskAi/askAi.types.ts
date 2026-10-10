export type AskAiRequestContext = {
    datasetUrn: string;
};

export type AskAiRequest = {
    context: AskAiRequestContext;
    question: string;
    conversationId?: string | null;
    requestId?: string;
    target: { mode: 'NEW_TAB' };
};

export type AskAiSqlAction = {
    type: 'CREATE_TAB';
    title: string;
    statement: string;
    dialect: string;
};

export type AskAiSource = { title: string; url?: string };

export type AskAiConversation = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
};

export type AskAiMessage = {
    id: string;
    sequence: number;
    role: 'user' | 'assistant';
    text: string;
    datasetUrn: string;
    datasetName: string;
    createdAt: string;
    requestId: string;
    status: 'pending' | 'completed' | 'failed';
    sqlAction?: AskAiSqlAction;
    sources: AskAiSource[];
    queryTabId?: string;
};

export type AskAiConversationList = {
    conversations: AskAiConversation[];
    nextOffset: number | null;
};

export type AskAiConversationDetail = {
    conversation: AskAiConversation;
    messages: AskAiMessage[];
    nextBefore: number | null;
};

export type AskAiResponse = {
    requestId: string;
    conversationId: string;
    messageId: string;
    answer: string;
    sqlAction?: AskAiSqlAction;
    sources: AskAiSource[];
    conversation: AskAiConversation;
    userMessage: AskAiMessage;
    assistantMessage: AskAiMessage;
};
