export type AskAiRequestContext = {
    datasetUrn: string;
    userUrn: string;
};

export type AskAiNewTabTarget = {
    mode: 'NEW_TAB';
};

export type AskAiRequest = {
    context: AskAiRequestContext;
    question: string;
    conversationId?: string | null;
    target: AskAiNewTabTarget;
};

export type AskAiSqlAction = {
    type: 'CREATE_TAB';
    title: string;
    statement: string;
    dialect: string;
};

export type AskAiSource = {
    title: string;
    url?: string;
};

export type AskAiResponse = {
    requestId?: string;
    conversationId: string;
    messageId: string;
    answer: string;
    sqlAction?: AskAiSqlAction;
    sources: AskAiSource[];
};
