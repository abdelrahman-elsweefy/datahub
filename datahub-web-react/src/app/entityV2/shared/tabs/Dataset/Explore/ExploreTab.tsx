import { Alert, Button, Column, EmptyState, Loader, Pill, Table, Text } from '@components';
import Editor from '@monaco-editor/react';
import { Broom } from '@phosphor-icons/react/dist/csr/Broom';
import { Database } from '@phosphor-icons/react/dist/csr/Database';
import { Play } from '@phosphor-icons/react/dist/csr/Play';
import { Table as TableIcon } from '@phosphor-icons/react/dist/csr/Table';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styled from 'styled-components';

import { useEntityData } from '@app/entity/shared/EntityContext';
import { QueryServiceError, runDatasetQuery } from '@app/entityV2/shared/tabs/Dataset/Explore/queryService';
import { DatasetQueryResult, QueryResultRow } from '@app/entityV2/shared/tabs/Dataset/Explore/types';
import { EntityTabProps } from '@app/entityV2/shared/types';
import { useMonacoTheme } from '@app/theme/useMonacoTheme';

const DEFAULT_LIMIT = 100;
const EDITOR_HEIGHT = '240px';

const Page = styled.div`
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 100%;
    padding: 20px 24px 32px;
    background: ${(props) => props.theme.colors.bg};
`;

const PageHeader = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
`;

const HeaderCopy = styled.div`
    display: flex;
    flex-direction: column;
    gap: 4px;
`;

const Card = styled.section`
    overflow: hidden;
    border: 1px solid ${(props) => props.theme.colors.border};
    border-radius: 8px;
    background: ${(props) => props.theme.colors.bgSurface};
`;

const CardHeader = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 52px;
    padding: 10px 16px;
    border-bottom: 1px solid ${(props) => props.theme.colors.border};
`;

const CardHeaderCopy = styled.div`
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
`;

const EditorContainer = styled.div`
    background: ${(props) => props.theme.colors.bg};
`;

const EditorActions = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    border-top: 1px solid ${(props) => props.theme.colors.border};
`;

const ButtonGroup = styled.div`
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
`;

const ResultsBody = styled.div`
    min-height: 230px;
`;

const CenteredState = styled.div`
    display: flex;
    min-height: 230px;
    align-items: center;
    justify-content: center;
`;

const ErrorContainer = styled.div`
    padding: 16px;
`;

const CellValue = styled.span`
    display: block;
    max-width: 420px;
    overflow: hidden;
    color: ${(props) => props.theme.colors.text};
    font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
`;

function getQualifiedName(entityName?: string | null): string | null {
    if (!entityName) {
        return null;
    }
    const parts = entityName.split('.').filter(Boolean);
    const sqlParts = parts.slice(-2);
    const identifiersAreSafe = sqlParts.every((part) => /^[A-Za-z_][A-Za-z0-9_$]*$/.test(part));
    return identifiersAreSafe ? sqlParts.join('.') : null;
}

function buildDefaultQuery(entityName?: string | null): string {
    const qualifiedName = getQualifiedName(entityName);
    if (!qualifiedName) {
        return '';
    }
    return `SELECT *\nFROM ${qualifiedName}\nLIMIT ${DEFAULT_LIMIT};`;
}

function formatCellValue(value: unknown): string {
    if (value === null) {
        return 'NULL';
    }
    if (value === undefined) {
        return '—';
    }
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
    }
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function getErrorTitleKey(error: Error): string {
    if (error instanceof QueryServiceError && (error.status === 401 || error.status === 403)) {
        return 'explore.accessErrorTitle';
    }
    if (error instanceof QueryServiceError && error.status >= 400 && error.status < 500) {
        return 'explore.queryErrorTitle';
    }
    return 'explore.serviceErrorTitle';
}

export default function ExploreTab(_props: EntityTabProps) {
    const { t } = useTranslation('entity.profile.queries');
    const { urn, entityData } = useEntityData();
    const monacoTheme = useMonacoTheme();
    const abortController = useRef<AbortController | null>(null);
    const [query, setQuery] = useState('');
    const [hasInitializedQuery, setHasInitializedQuery] = useState(false);
    const [result, setResult] = useState<DatasetQueryResult | null>(null);
    const [error, setError] = useState<Error | null>(null);
    const [isRunning, setIsRunning] = useState(false);

    const entityName = entityData?.properties?.qualifiedName || entityData?.properties?.name || entityData?.name;

    useEffect(() => {
        if (!hasInitializedQuery && entityName) {
            setQuery(buildDefaultQuery(entityName));
            setHasInitializedQuery(true);
        }
    }, [entityName, hasInitializedQuery]);

    useEffect(
        () => () => {
            abortController.current?.abort();
        },
        [],
    );

    const columns = useMemo<Column<QueryResultRow>[]>(
        () =>
            result?.columns.map((column) => ({
                key: column.name,
                title: (
                    <CardHeaderCopy>
                        <Text weight="semiBold" size="sm">
                            {column.name}
                        </Text>
                        {column.type && <Text size="xs">{column.type}</Text>}
                    </CardHeaderCopy>
                ),
                minWidth: '160px',
                render: (row) => {
                    const value = formatCellValue(row[column.name]);
                    return <CellValue title={value}>{value}</CellValue>;
                },
            })) ?? [],
        [result],
    );

    const runQuery = async () => {
        if (!urn || !query.trim() || isRunning) {
            return;
        }

        abortController.current?.abort();
        const controller = new AbortController();
        abortController.current = controller;
        setIsRunning(true);
        setError(null);

        try {
            const nextResult = await runDatasetQuery({ datasetUrn: urn, sql: query.trim() }, controller.signal);
            setResult(nextResult);
        } catch (requestError) {
            if (requestError instanceof DOMException && requestError.name === 'AbortError') {
                return;
            }
            setResult(null);
            setError(requestError instanceof Error ? requestError : new Error(t('explore.unexpectedError')));
        } finally {
            if (abortController.current === controller) {
                abortController.current = null;
                setIsRunning(false);
            }
        }
    };

    const clearQuery = () => {
        setQuery('');
        setResult(null);
        setError(null);
    };

    const renderResults = () => {
        if (isRunning) {
            return (
                <CenteredState data-testid="explore-query-loading">
                    <Loader size="lg" alignItems="center" />
                </CenteredState>
            );
        }
        if (error) {
            return (
                <ErrorContainer>
                    <Alert
                        variant="error"
                        title={t(getErrorTitleKey(error))}
                        description={t('explore.errorDescription')}
                        errorMessage={error.message}
                        action={{
                            label: t('explore.retry'),
                            onClick: runQuery,
                            dataTestId: 'explore-query-retry',
                        }}
                    />
                </ErrorContainer>
            );
        }
        if (!result) {
            return (
                <EmptyState
                    icon={TableIcon}
                    title={t('explore.emptyInitialTitle')}
                    description={t('explore.emptyInitialDescription')}
                />
            );
        }
        if (result.rows.length === 0) {
            return (
                <EmptyState
                    icon={Database}
                    title={t('explore.emptyResultTitle')}
                    description={t('explore.emptyResultDescription')}
                />
            );
        }
        return <Table columns={columns} data={result.rows} isScrollable maxHeight="440px" />;
    };

    return (
        <Page>
            <PageHeader>
                <HeaderCopy>
                    <Text size="xl" weight="bold">
                        {t('explore.title')}
                    </Text>
                    <Text>{t('explore.description')}</Text>
                </HeaderCopy>
                <Pill label={t('explore.readOnly')} color="green" variant="outline" size="sm" />
            </PageHeader>

            <Card>
                <CardHeader>
                    <CardHeaderCopy>
                        <Text weight="semiBold">{t('explore.editorTitle')}</Text>
                        {entityName && <Text size="sm">{entityName}</Text>}
                    </CardHeaderCopy>
                    <Text size="sm">{t('explore.limitNotice', { limit: DEFAULT_LIMIT })}</Text>
                </CardHeader>
                <EditorContainer>
                    <Editor
                        {...monacoTheme}
                        height={EDITOR_HEIGHT}
                        language="sql"
                        value={query}
                        onChange={(value) => setQuery(value ?? '')}
                        options={{
                            minimap: { enabled: false },
                            automaticLayout: true,
                            fontSize: 13,
                            lineNumbersMinChars: 3,
                            padding: { top: 16, bottom: 16 },
                            scrollBeyondLastLine: false,
                            wordWrap: 'on',
                        }}
                    />
                </EditorContainer>
                <EditorActions>
                    <Text size="sm">{t('explore.securityNotice')}</Text>
                    <ButtonGroup>
                        <Button
                            variant="text"
                            size="sm"
                            icon={{ icon: Broom }}
                            onClick={clearQuery}
                            disabled={!query && !result && !error}
                        >
                            {t('explore.clear')}
                        </Button>
                        <Button
                            size="sm"
                            icon={{ icon: Play, weight: 'fill' }}
                            onClick={runQuery}
                            disabled={!urn || !query.trim() || isRunning}
                            isLoading={isRunning}
                            data-testid="explore-run-query"
                        >
                            {t('explore.run')}
                        </Button>
                    </ButtonGroup>
                </EditorActions>
            </Card>

            <Card>
                <CardHeader>
                    <CardHeaderCopy>
                        <Text weight="semiBold">{t('explore.resultsTitle')}</Text>
                        {result && !isRunning && (
                            <Text size="sm">
                                {result.executionTimeMs === undefined
                                    ? t('explore.resultCount', { count: result.rowCount })
                                    : t('explore.resultSummary', {
                                          count: result.rowCount,
                                          duration: result.executionTimeMs,
                                      })}
                            </Text>
                        )}
                    </CardHeaderCopy>
                    {result?.truncated && <Pill label={t('explore.truncated')} color="yellow" size="sm" />}
                </CardHeader>
                <ResultsBody>{renderResults()}</ResultsBody>
            </Card>
        </Page>
    );
}
