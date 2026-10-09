import { Icon, Tooltip } from '@components';
import { Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { X } from '@phosphor-icons/react/dist/csr/X';
import React, { KeyboardEvent, MouseEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styled from 'styled-components';

import { useQueryWorkspace } from '@app/entityV2/shared/tabs/Dataset/Explore/QueryWorkspaceContext';
import { QueryTab } from '@app/entityV2/shared/tabs/Dataset/Explore/queryWorkspace.types';
import { ConfirmationModal } from '@app/sharedV2/modals/ConfirmationModal';

const Container = styled.div`
    display: flex;
    align-items: stretch;
    min-height: 42px;
    border-bottom: 1px solid ${(props) => props.theme.colors.border};
    background: ${(props) => props.theme.colors.bgSurface};
`;

const TabScroller = styled.div`
    display: flex;
    flex: 1;
    min-width: 0;
    overflow-x: auto;

    &::-webkit-scrollbar {
        height: 4px;
    }
`;

const TabItem = styled.div<{ $active: boolean }>`
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    min-width: 132px;
    max-width: 220px;
    border-right: 1px solid ${(props) => props.theme.colors.border};
    border-top: 2px solid ${(props) => (props.$active ? props.theme.colors.borderBrand : 'transparent')};
    background: ${(props) => (props.$active ? props.theme.colors.bg : props.theme.colors.bgSurface)};
`;

const TabSelectButton = styled.button`
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: center;
    gap: 6px;
    padding: 9px 4px 9px 12px;
    border: 0;
    background: transparent;
    color: ${(props) => props.theme.colors.text};
    cursor: pointer;
    font: inherit;
    text-align: left;

    &:focus-visible {
        outline: 2px solid ${(props) => props.theme.colors.borderBrand};
        outline-offset: -2px;
    }
`;

const TabTitle = styled.span`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
`;

const RenameInput = styled.input`
    width: 100%;
    min-width: 80px;
    padding: 3px 5px;
    border: 1px solid ${(props) => props.theme.colors.borderBrand};
    border-radius: 4px;
    background: ${(props) => props.theme.colors.bg};
    color: ${(props) => props.theme.colors.text};
    font: inherit;
`;

const DirtyDot = styled.span`
    width: 6px;
    height: 6px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: ${(props) => props.theme.colors.iconBrand};
`;

const IconButton = styled.button`
    display: flex;
    width: 30px;
    height: 30px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    margin: 0 4px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: ${(props) => props.theme.colors.icon};
    cursor: pointer;

    &:hover:not(:disabled) {
        background: ${(props) => props.theme.colors.bgHover};
    }

    &:disabled {
        cursor: not-allowed;
        opacity: 0.45;
    }
`;

export default function QueryTabBar() {
    const { t } = useTranslation('entity.profile.queries');
    const { workspace, canCreateTab, createTab, renameTab, closeTab, setActiveTab } = useQueryWorkspace();
    const [editingTabId, setEditingTabId] = useState<string | null>(null);
    const [editingTitle, setEditingTitle] = useState('');
    const [tabPendingClose, setTabPendingClose] = useState<QueryTab | null>(null);

    const startRenaming = (tab: QueryTab) => {
        setEditingTabId(tab.id);
        setEditingTitle(tab.title);
    };

    const finishRenaming = () => {
        if (editingTabId && editingTitle.trim()) {
            renameTab(editingTabId, editingTitle);
        }
        setEditingTabId(null);
        setEditingTitle('');
    };

    const handleRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
            finishRenaming();
        } else if (event.key === 'Escape') {
            setEditingTabId(null);
            setEditingTitle('');
        }
    };

    const handleClose = (event: MouseEvent<HTMLButtonElement>, tab: QueryTab) => {
        event.stopPropagation();
        if (workspace.tabs.length === 1) {
            return;
        }
        if (tab.isDirty) {
            setTabPendingClose(tab);
        } else {
            closeTab(tab.id);
        }
    };

    return (
        <>
            <Container aria-label={t('explore.tabs.label')}>
                <TabScroller role="tablist">
                    {workspace.tabs.map((tab) => {
                        const isActive = workspace.activeTabId === tab.id;
                        return (
                            <TabItem key={tab.id} $active={isActive}>
                                <TabSelectButton
                                    type="button"
                                    role="tab"
                                    aria-selected={isActive}
                                    data-testid={`query-tab-${tab.id}`}
                                    onClick={() => setActiveTab(tab.id)}
                                    onDoubleClick={() => startRenaming(tab)}
                                >
                                    {tab.isDirty && <DirtyDot title={t('explore.tabs.modified')} />}
                                    {editingTabId === tab.id ? (
                                        <RenameInput
                                            autoFocus
                                            aria-label={t('explore.tabs.renameLabel')}
                                            value={editingTitle}
                                            onChange={(event) => setEditingTitle(event.target.value)}
                                            onBlur={finishRenaming}
                                            onKeyDown={handleRenameKeyDown}
                                            onClick={(event) => event.stopPropagation()}
                                        />
                                    ) : (
                                        <TabTitle title={tab.title}>{tab.title}</TabTitle>
                                    )}
                                </TabSelectButton>
                                <Tooltip title={t('explore.tabs.close')}>
                                    <IconButton
                                        type="button"
                                        aria-label={t('explore.tabs.closeNamed', { name: tab.title })}
                                        disabled={workspace.tabs.length === 1}
                                        onClick={(event) => handleClose(event, tab)}
                                    >
                                        <Icon icon={X} size="sm" />
                                    </IconButton>
                                </Tooltip>
                            </TabItem>
                        );
                    })}
                </TabScroller>
                <Tooltip title={canCreateTab ? t('explore.tabs.new') : t('explore.tabs.limit')}>
                    <IconButton
                        type="button"
                        aria-label={t('explore.tabs.new')}
                        disabled={!canCreateTab}
                        onClick={() => createTab({ isDirty: false })}
                        data-testid="query-tab-add"
                    >
                        <Icon icon={Plus} size="md" />
                    </IconButton>
                </Tooltip>
            </Container>
            <ConfirmationModal
                isOpen={Boolean(tabPendingClose)}
                modalTitle={t('explore.tabs.closeConfirmTitle')}
                modalText={t('explore.tabs.closeConfirmDescription', { name: tabPendingClose?.title || '' })}
                confirmButtonText={t('explore.tabs.close')}
                isDeleteModal
                handleClose={() => setTabPendingClose(null)}
                handleConfirm={() => {
                    if (tabPendingClose) {
                        closeTab(tabPendingClose.id);
                    }
                    setTabPendingClose(null);
                }}
            />
        </>
    );
}
