import { describe, expect, it } from 'vitest';

import {
    createInitialQueryWorkspace,
    createQueryTab,
    queryWorkspaceReducer,
    restoreQueryWorkspace,
} from '@app/entityV2/shared/tabs/Dataset/Explore/queryWorkspaceReducer';

const DATASET_URN = 'urn:li:dataset:(urn:li:dataPlatform:postgres,my_db.my_schema.events,PROD)';

function initialWorkspace() {
    return createInitialQueryWorkspace(DATASET_URN, createQueryTab('tab-1', 'Query 1', {}, 1));
}

describe('queryWorkspaceReducer', () => {
    it('stores connections per tab and prevents a late default from replacing a user choice', () => {
        let workspace = queryWorkspaceReducer(initialWorkspace(), {
            type: 'SET_CONNECTION',
            tabId: 'tab-1',
            connectionId: 'analytics',
        });
        workspace = queryWorkspaceReducer(workspace, {
            type: 'ADD_TAB',
            tab: createQueryTab('tab-2', 'Query 2', { connectionId: 'reporting' }, 2),
        });
        workspace = queryWorkspaceReducer(workspace, {
            type: 'SET_CONNECTION',
            tabId: 'tab-1',
            connectionId: 'default',
            initialize: true,
        });
        expect(workspace.tabs.map((tab) => tab.connectionId)).toEqual(['analytics', 'reporting']);
        expect(restoreQueryWorkspace(JSON.stringify(workspace), DATASET_URN)).toEqual(workspace);
    });
    it('keeps SQL isolated while switching between tabs', () => {
        const firstWorkspace = queryWorkspaceReducer(initialWorkspace(), {
            type: 'UPDATE_SQL',
            tabId: 'tab-1',
            sql: 'SELECT 1',
        });
        const secondWorkspace = queryWorkspaceReducer(firstWorkspace, {
            type: 'ADD_TAB',
            tab: createQueryTab('tab-2', 'Query 2', { sql: 'SELECT 2' }, 2),
        });

        expect(secondWorkspace.activeTabId).toBe('tab-2');
        expect(secondWorkspace.tabs.map((tab) => tab.sql)).toEqual(['SELECT 1', 'SELECT 2']);
    });

    it('selects the neighboring tab when closing the active tab and keeps one tab open', () => {
        const workspace = queryWorkspaceReducer(initialWorkspace(), {
            type: 'ADD_TAB',
            tab: createQueryTab('tab-2', 'Query 2', {}, 2),
        });
        const closedWorkspace = queryWorkspaceReducer(workspace, { type: 'CLOSE_TAB', tabId: 'tab-2' });
        const lastCloseAttempt = queryWorkspaceReducer(closedWorkspace, { type: 'CLOSE_TAB', tabId: 'tab-1' });

        expect(closedWorkspace.activeTabId).toBe('tab-1');
        expect(lastCloseAttempt.tabs).toHaveLength(1);
    });

    it('does not overwrite an edited tab during default SQL initialization', () => {
        const editedWorkspace = queryWorkspaceReducer(initialWorkspace(), {
            type: 'UPDATE_SQL',
            tabId: 'tab-1',
            sql: '',
        });
        const initializedWorkspace = queryWorkspaceReducer(editedWorkspace, {
            type: 'INITIALIZE_SQL',
            tabId: 'tab-1',
            sql: 'SELECT * FROM my_schema.events',
        });

        expect(initializedWorkspace.tabs[0]?.sql).toBe('');
        expect(initializedWorkspace.tabs[0]?.revision).toBe(1);
    });
});

describe('restoreQueryWorkspace', () => {
    it('restores valid state for the same dataset', () => {
        const workspace = initialWorkspace();
        expect(restoreQueryWorkspace(JSON.stringify(workspace), DATASET_URN)).toEqual(workspace);
    });

    it('rejects malformed and cross-dataset state', () => {
        expect(restoreQueryWorkspace('{not-json', DATASET_URN)).toBeNull();
        expect(restoreQueryWorkspace(JSON.stringify(initialWorkspace()), 'urn:li:dataset:other')).toBeNull();
    });
});
