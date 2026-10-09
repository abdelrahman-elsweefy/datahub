import {
    CreateQueryTabInput,
    QueryTab,
    QueryTabSource,
    QueryWorkspace,
} from '@app/entityV2/shared/tabs/Dataset/Explore/queryWorkspace.types';

export const QUERY_WORKSPACE_VERSION = 1;
export const MAX_QUERY_TABS = 20;

export type QueryWorkspaceAction =
    | { type: 'ADD_TAB'; tab: QueryTab }
    | { type: 'INITIALIZE_SQL'; tabId: string; sql: string }
    | { type: 'UPDATE_SQL'; tabId: string; sql: string }
    | { type: 'RENAME_TAB'; tabId: string; title: string }
    | { type: 'CLOSE_TAB'; tabId: string }
    | { type: 'SET_ACTIVE_TAB'; tabId: string }
    | { type: 'SET_CONNECTION'; tabId: string; connectionId: string; initialize?: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isQueryTabSource(value: unknown): value is QueryTabSource {
    return value === 'user' || value === 'ai';
}

function normalizePersistedTab(value: unknown): QueryTab | null {
    if (!isRecord(value)) {
        return null;
    }

    const { id, title, sql, dialect, connectionId, source, sourceMessageId, isDirty, revision, createdAt, updatedAt } =
        value;
    if (
        typeof id !== 'string' ||
        !id ||
        typeof title !== 'string' ||
        !title ||
        typeof sql !== 'string' ||
        typeof dialect !== 'string' ||
        (connectionId !== undefined && (typeof connectionId !== 'string' || !connectionId)) ||
        !isQueryTabSource(source) ||
        typeof isDirty !== 'boolean' ||
        typeof revision !== 'number' ||
        typeof createdAt !== 'number' ||
        typeof updatedAt !== 'number'
    ) {
        return null;
    }

    return {
        id,
        title,
        sql,
        dialect,
        connectionId: typeof connectionId === 'string' ? connectionId : undefined,
        source,
        sourceMessageId: typeof sourceMessageId === 'string' ? sourceMessageId : undefined,
        isDirty,
        revision,
        createdAt,
        updatedAt,
    };
}

export function getQueryWorkspaceStorageKey(datasetUrn: string): string {
    return `datahub.dataset-query-workspace.v${QUERY_WORKSPACE_VERSION}.${encodeURIComponent(datasetUrn)}`;
}

export function createQueryTab(id: string, title: string, input: CreateQueryTabInput = {}, now = Date.now()): QueryTab {
    return {
        id,
        title: input.title?.trim() || title,
        sql: input.sql || '',
        dialect: input.dialect || 'sql',
        connectionId: input.connectionId,
        source: input.source || 'user',
        sourceMessageId: input.sourceMessageId,
        isDirty: input.isDirty ?? Boolean(input.sql),
        revision: 0,
        createdAt: now,
        updatedAt: now,
    };
}

export function createInitialQueryWorkspace(datasetUrn: string, tab: QueryTab): QueryWorkspace {
    return {
        version: QUERY_WORKSPACE_VERSION,
        datasetUrn,
        activeTabId: tab.id,
        tabs: [tab],
    };
}

export function restoreQueryWorkspace(value: string | null, datasetUrn: string): QueryWorkspace | null {
    if (!value) {
        return null;
    }

    try {
        const parsed: unknown = JSON.parse(value);
        if (
            !isRecord(parsed) ||
            parsed.version !== QUERY_WORKSPACE_VERSION ||
            parsed.datasetUrn !== datasetUrn ||
            typeof parsed.activeTabId !== 'string' ||
            !Array.isArray(parsed.tabs)
        ) {
            return null;
        }

        const tabs = parsed.tabs.map(normalizePersistedTab).filter((tab): tab is QueryTab => tab !== null);
        if (tabs.length === 0 || tabs.length > MAX_QUERY_TABS || !tabs.some((tab) => tab.id === parsed.activeTabId)) {
            return null;
        }

        return {
            version: QUERY_WORKSPACE_VERSION,
            datasetUrn,
            activeTabId: parsed.activeTabId,
            tabs,
        };
    } catch {
        return null;
    }
}

export function queryWorkspaceReducer(state: QueryWorkspace, action: QueryWorkspaceAction): QueryWorkspace {
    switch (action.type) {
        case 'SET_CONNECTION':
            return {
                ...state,
                tabs: state.tabs.map((tab) =>
                    tab.id === action.tabId &&
                    !(action.initialize && tab.connectionId) &&
                    tab.connectionId !== action.connectionId
                        ? {
                              ...tab,
                              connectionId: action.connectionId,
                              revision: tab.revision + (action.initialize ? 0 : 1),
                              updatedAt: Date.now(),
                          }
                        : tab,
                ),
            };
        case 'ADD_TAB':
            if (state.tabs.length >= MAX_QUERY_TABS || state.tabs.some((tab) => tab.id === action.tab.id)) {
                return state;
            }
            return {
                ...state,
                activeTabId: action.tab.id,
                tabs: [...state.tabs, action.tab],
            };
        case 'INITIALIZE_SQL':
            return {
                ...state,
                tabs: state.tabs.map((tab) =>
                    tab.id === action.tabId && tab.revision === 0 && !tab.sql
                        ? { ...tab, sql: action.sql, updatedAt: Date.now() }
                        : tab,
                ),
            };
        case 'UPDATE_SQL':
            return {
                ...state,
                tabs: state.tabs.map((tab) =>
                    tab.id === action.tabId
                        ? {
                              ...tab,
                              sql: action.sql,
                              isDirty: true,
                              revision: tab.revision + 1,
                              updatedAt: Date.now(),
                          }
                        : tab,
                ),
            };
        case 'RENAME_TAB': {
            const title = action.title.trim();
            if (!title) {
                return state;
            }
            return {
                ...state,
                tabs: state.tabs.map((tab) =>
                    tab.id === action.tabId
                        ? { ...tab, title, isDirty: true, revision: tab.revision + 1, updatedAt: Date.now() }
                        : tab,
                ),
            };
        }
        case 'CLOSE_TAB': {
            if (state.tabs.length === 1) {
                return state;
            }
            const closingIndex = state.tabs.findIndex((tab) => tab.id === action.tabId);
            if (closingIndex < 0) {
                return state;
            }
            const tabs = state.tabs.filter((tab) => tab.id !== action.tabId);
            const activeTabId =
                state.activeTabId === action.tabId
                    ? tabs[Math.min(closingIndex, tabs.length - 1)]?.id || tabs[0]?.id || state.activeTabId
                    : state.activeTabId;
            return { ...state, activeTabId, tabs };
        }
        case 'SET_ACTIVE_TAB':
            return state.tabs.some((tab) => tab.id === action.tabId) ? { ...state, activeTabId: action.tabId } : state;
        default:
            return state;
    }
}
