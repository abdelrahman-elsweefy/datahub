import React, { ReactNode, useEffect, useMemo, useReducer, useRef } from 'react';

import {
    QueryWorkspaceContext,
    QueryWorkspaceContextValue,
} from '@app/entityV2/shared/tabs/Dataset/Explore/QueryWorkspaceContext';
import { CreateQueryTabInput, QueryTab } from '@app/entityV2/shared/tabs/Dataset/Explore/queryWorkspace.types';
import {
    MAX_QUERY_TABS,
    createInitialQueryWorkspace,
    createQueryTab,
    getQueryWorkspaceStorageKey,
    queryWorkspaceReducer,
    restoreQueryWorkspace,
} from '@app/entityV2/shared/tabs/Dataset/Explore/queryWorkspaceReducer';

type Props = {
    datasetUrn: string;
    children: ReactNode;
};

function generateTabId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `query-tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getNextTabTitle(tabs: QueryTab[]): string {
    const usedNumbers = new Set(
        tabs.flatMap((tab) => {
            const match = /^Query (\d+)$/.exec(tab.title);
            return match?.[1] ? [Number(match[1])] : [];
        }),
    );
    let candidate = 1;
    while (usedNumbers.has(candidate)) {
        candidate += 1;
    }
    return `Query ${candidate}`;
}

function initializeWorkspace(datasetUrn: string) {
    const storedValue = (() => {
        try {
            return window.sessionStorage.getItem(getQueryWorkspaceStorageKey(datasetUrn));
        } catch {
            return null;
        }
    })();
    const restored = restoreQueryWorkspace(storedValue, datasetUrn);
    if (restored) {
        return restored;
    }
    return createInitialQueryWorkspace(datasetUrn, createQueryTab(generateTabId(), 'Query 1', { isDirty: false }));
}

export function QueryWorkspaceProvider({ datasetUrn, children }: Props) {
    const [workspace, dispatch] = useReducer(queryWorkspaceReducer, datasetUrn, initializeWorkspace);
    const workspaceRef = useRef(workspace);
    workspaceRef.current = workspace;

    useEffect(() => {
        const timeout = window.setTimeout(() => {
            try {
                window.sessionStorage.setItem(getQueryWorkspaceStorageKey(datasetUrn), JSON.stringify(workspace));
            } catch {
                // The workspace remains available in memory when browser storage is unavailable.
            }
        }, 200);
        return () => window.clearTimeout(timeout);
    }, [datasetUrn, workspace]);

    const value = useMemo<QueryWorkspaceContextValue>(() => {
        const createTab = (input: CreateQueryTabInput = {}): QueryTab | null => {
            const currentWorkspace = workspaceRef.current;
            if (currentWorkspace.tabs.length >= MAX_QUERY_TABS) {
                return null;
            }
            const tab = createQueryTab(generateTabId(), getNextTabTitle(currentWorkspace.tabs), input);
            dispatch({ type: 'ADD_TAB', tab });
            return tab;
        };

        return {
            workspace,
            activeTab: workspace.tabs.find((tab) => tab.id === workspace.activeTabId) || workspace.tabs[0],
            canCreateTab: workspace.tabs.length < MAX_QUERY_TABS,
            createTab,
            initializeTabSql: (tabId, sql) => dispatch({ type: 'INITIALIZE_SQL', tabId, sql }),
            updateTabSql: (tabId, sql) => dispatch({ type: 'UPDATE_SQL', tabId, sql }),
            renameTab: (tabId, title) => dispatch({ type: 'RENAME_TAB', tabId, title }),
            closeTab: (tabId) => dispatch({ type: 'CLOSE_TAB', tabId }),
            setActiveTab: (tabId) => dispatch({ type: 'SET_ACTIVE_TAB', tabId }),
        };
    }, [workspace]);

    return <QueryWorkspaceContext.Provider value={value}>{children}</QueryWorkspaceContext.Provider>;
}
