import { createContext, useContext } from 'react';

import {
    CreateQueryTabInput,
    QueryTab,
    QueryWorkspace,
} from '@app/entityV2/shared/tabs/Dataset/Explore/queryWorkspace.types';

export type QueryWorkspaceContextValue = {
    workspace: QueryWorkspace;
    activeTab: QueryTab;
    canCreateTab: boolean;
    createTab: (input?: CreateQueryTabInput) => QueryTab | null;
    initializeTabSql: (tabId: string, sql: string) => void;
    updateTabSql: (tabId: string, sql: string) => void;
    renameTab: (tabId: string, title: string) => void;
    closeTab: (tabId: string) => void;
    setActiveTab: (tabId: string) => void;
};

export const QueryWorkspaceContext = createContext<QueryWorkspaceContextValue | null>(null);

export function useQueryWorkspace(): QueryWorkspaceContextValue {
    const context = useContext(QueryWorkspaceContext);
    if (!context) {
        throw new Error('useQueryWorkspace must be used inside QueryWorkspaceProvider');
    }
    return context;
}
