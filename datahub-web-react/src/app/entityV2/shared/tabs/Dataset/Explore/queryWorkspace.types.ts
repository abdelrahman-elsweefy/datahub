export type QueryTabSource = 'user' | 'ai';

export type QueryTab = {
    id: string;
    title: string;
    sql: string;
    dialect: string;
    source: QueryTabSource;
    sourceMessageId?: string;
    isDirty: boolean;
    revision: number;
    createdAt: number;
    updatedAt: number;
};

export type QueryWorkspace = {
    version: 1;
    datasetUrn: string;
    activeTabId: string;
    tabs: QueryTab[];
};

export type CreateQueryTabInput = {
    title?: string;
    sql?: string;
    dialect?: string;
    source?: QueryTabSource;
    sourceMessageId?: string;
    isDirty?: boolean;
};
