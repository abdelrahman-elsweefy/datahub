# Dataset Ask AI and Query Workspace Plan

## Status

Proposed. This document must be reviewed before implementation begins.

This design extends the dataset Explore experience described in
[`dataset-explore-ui-plan.md`](dataset-explore-ui-plan.md). Explore remains responsible for editing
and running SQL, while a new **Ask AI** dataset sidebar tab helps users understand an asset and
create or revise queries. Query execution and AI processing remain separate services outside
DataHub's GMS.

## Goals

- Add an **Ask AI** icon to the dataset profile's right vertical sidebar.
- Give non-technical users a conversational way to ask questions about the current data asset.
- Turn Explore into a multi-tab SQL workspace.
- Create a new query tab for AI-generated SQL by default.
- Allow a user to explicitly ask AI to revise one selected query tab.
- Keep generated SQL reviewable and require the user to run it explicitly.
- Keep the frontend independent of a specific model, MCP server, or tool provider.
- Preserve the existing query-service security boundary.

## Non-goals for the first version

- Executing SQL from the Ask AI panel.
- Allowing AI to modify more than one query tab in a single response.
- Saving workspaces or conversations to a DataHub backend.
- Sharing query workspaces between users.
- Building the AI/MCP service as part of the DataHub GMS.
- Exposing database credentials, MCP credentials, or model credentials to the browser.
- Allowing generated write statements to bypass the query service's read-only validation.

## User experience

### Ask AI sidebar

The right vertical sidebar gains an **Ask AI** item with a sparkles or assistant icon. Selecting it
opens a panel in the same area used by Summary, Lineage, Columns, and Props.

The panel contains:

- A short explanation of what the assistant can do.
- Suggested prompts when the conversation is empty.
- A scrollable conversation history.
- A SQL destination selector.
- A multiline prompt field.
- An **Ask** button.
- Loading, unavailable-service, authorization, and recoverable error states.

Pressing `Enter` submits a non-empty prompt. Pressing `Shift+Enter` inserts a newline. The Ask
button is disabled while a request is running.

### SQL destination

Every request has an explicit destination:

1. **New query tab**, which is always the default.
2. **Modify an existing tab**, selected from the current dataset workspace.

For a new-tab request, the frontend does not send the contents of unrelated query tabs. For a
modify request, it sends only the ID, title, dialect, and current SQL of the selected tab.

### AI-generated SQL

When the service returns SQL for the default new-tab destination, the frontend:

1. Creates a new query tab with a generated, editable title.
2. Stores the returned SQL in that tab.
3. Marks its source as AI.
4. Makes the new tab active.
5. Navigates the dataset's main content to Explore.
6. Leaves execution to the user.

The assistant message also displays the SQL with **Open in Explore** and **Copy SQL** actions.
Repeated activation of **Open in Explore** focuses the already-created tab instead of creating a
duplicate.

### Modifying an existing tab

When the user selects an existing tab, the service returns a proposed replacement statement. The
frontend does not immediately overwrite the tab. It displays a proposal with:

- The target tab name.
- The proposed SQL.
- **Apply changes**.
- **Create as new tab**.
- **Discard**.

Applying the proposal updates only the requested tab and marks it as modified. If the tab was
closed or changed while the request was running, the proposal is not applied silently. The user
can create a new tab from the proposal instead.

### Query workspace tabs

Explore gains a query-tab row above the editor:

```text
[ Query 1 ] [ Active customers ] [ AI Query 1 ] [ + ]
```

Users can:

- Create a blank tab.
- Switch tabs without losing SQL.
- Rename a tab.
- Close a tab.
- See which tab is active and which tabs contain modifications.
- Keep at least one tab open.

Closing a modified tab requires confirmation. The first version limits the workspace to 20 tabs
per dataset to avoid accidental browser-storage growth.

## Frontend state model

A dataset-scoped workspace provider must be mounted above both the main profile tab content and the
right sidebar. This allows Ask AI to create or update query tabs even when Explore is not currently
selected.

```ts
type QueryTabSource = "user" | "ai";

interface QueryTab {
  id: string;
  title: string;
  sql: string;
  dialect: string;
  source: QueryTabSource;
  isDirty: boolean;
  createdAt: number;
  updatedAt: number;
}

interface DatasetQueryWorkspace {
  version: 1;
  datasetUrn: string;
  activeTabId: string;
  tabs: QueryTab[];
}
```

The provider exposes intent-based operations rather than allowing components to mutate state
directly:

```ts
createTab(input?: Partial<QueryTab>): QueryTab;
updateTabSql(tabId: string, sql: string): void;
renameTab(tabId: string, title: string): void;
closeTab(tabId: string): void;
setActiveTab(tabId: string): void;
resetWorkspace(): void;
```

Tab IDs are generated in the browser and are not derived from titles. Titles do not need to be
unique.

## Workspace persistence

The first version stores the workspace in `sessionStorage`, namespaced by an encoded or hashed
dataset URN and a schema version. This preserves tabs during profile navigation and page refreshes
without adding a backend dependency.

Persistence rules:

- Store SQL workspace state only; do not store credentials or tool output.
- Restore only data that passes runtime validation.
- Ignore incompatible versions and initialize a clean workspace.
- Debounce writes while the user types.
- Remove the oldest non-active AI tab if a future migration must enforce the tab limit.
- Keep conversation state in memory initially; conversation persistence can be added separately.

Longer-term persistence may move to a user-scoped query-workspace service. That change must not
alter the Ask AI response contract or grant additional query permissions.

## Frontend-to-AI-service contract

The browser calls a relative, same-origin path so deployments can proxy it to an independent
service without enabling cross-origin browser access.

```http
POST /ai-service/v1/ask
Content-Type: application/json
```

New-tab request:

```json
{
  "datasetUrn": "urn:li:dataset:(urn:li:dataPlatform:postgres,my_db.my_schema.events,PROD)",
  "question": "Show the number of events for each day",
  "conversationId": null,
  "target": {
    "mode": "NEW_TAB"
  }
}
```

Modify-tab request:

```json
{
  "datasetUrn": "urn:li:dataset:(urn:li:dataPlatform:postgres,my_db.my_schema.events,PROD)",
  "question": "Filter this to the last seven days",
  "conversationId": "conversation-123",
  "target": {
    "mode": "MODIFY_TAB",
    "tabId": "query-tab-2",
    "title": "Daily events",
    "dialect": "postgresql",
    "currentSql": "SELECT event_date, COUNT(*) FROM my_schema.events GROUP BY event_date"
  }
}
```

Successful response:

```json
{
  "conversationId": "conversation-123",
  "messageId": "message-456",
  "answer": "I added a seven-day filter while preserving the daily grouping.",
  "sqlAction": {
    "type": "UPDATE_TAB",
    "targetTabId": "query-tab-2",
    "title": "Daily events - last 7 days",
    "statement": "SELECT event_date, COUNT(*) FROM my_schema.events WHERE event_date >= CURRENT_DATE - INTERVAL '7 days' GROUP BY event_date",
    "dialect": "postgresql"
  },
  "sources": []
}
```

`sqlAction` is optional because some questions require only a natural-language answer. The first
version accepts at most one SQL action per response. The frontend never extracts executable SQL
from Markdown; it uses only `sqlAction.statement`.

Supported SQL action types are:

- `CREATE_TAB`, valid for a `NEW_TAB` request.
- `UPDATE_TAB`, valid for a `MODIFY_TAB` request and the requested tab ID.

The frontend rejects mismatched or malformed actions and still displays the safe explanatory
answer when possible.

Errors use an HTTP status and a safe response body:

```json
{
  "code": "AI_SERVICE_UNAVAILABLE",
  "message": "The assistant is temporarily unavailable"
}
```

The frontend also accepts FastAPI-style `detail` text for consistency with the query-service
client.

## AI and MCP service responsibilities

The future independent service will:

1. Derive the authenticated user from the trusted proxy or session integration.
2. Authorize that user to view and query the requested dataset URN.
3. Resolve asset metadata and schema server-side.
4. Select the model, MCP servers, and tools allowed for the request.
5. Treat dataset metadata and tool output as untrusted model context.
6. Limit tool calls, request duration, prompt size, and response size.
7. Return structured SQL separately from explanatory Markdown.
8. Record safe audit metadata without logging prompts or SQL by default.
9. Avoid exposing model, MCP, DataHub, or database credentials to the browser.
10. Never execute generated SQL through the Ask AI endpoint.

The service may explain metadata, suggest joins, or produce SQL using approved tools. The query
service remains the only component that may execute SQL and remains authoritative for read-only
validation, dataset scope, row limits, timeouts, and user authorization.

## Security and privacy boundaries

- AI-generated SQL is untrusted input.
- Generated SQL is never run automatically.
- The query service must validate AI-generated SQL exactly like user-written SQL.
- The browser sends only the selected tab's SQL for modification requests.
- Database credentials and connection strings never enter browser state.
- The frontend renders assistant text through safe Markdown components with raw HTML disabled.
- Tool traces are not rendered unless the service returns an approved, user-facing source model.
- Dataset access revocation must be enforced by both AI and query services on every request.
- A model response cannot choose an arbitrary target tab; the frontend validates it against the
  user's request and current workspace.

## Component boundaries

The implementation should keep these responsibilities separate:

- `DatasetQueryWorkspaceProvider`: tab state, persistence, and workspace actions.
- `QueryTabBar`: tab creation, selection, rename, close, and modified indicators.
- `ExploreTab`: editor and query results for the active query tab.
- `AskAiSidebarTab`: conversation UI, destination selection, and SQL proposals.
- `aiService`: request and response transport, validation, and error normalization.
- `queryService`: read-only query execution; it remains independent of AI behavior.

Exact filenames should follow the existing dataset profile and sidebar conventions discovered
during implementation rather than introducing a parallel framework.

## Implementation task plan

### Phase 0: confirm integration points

- Locate the entity-profile provider boundary shared by main tabs and right-sidebar tabs.
- Locate the sidebar tab registry and its icon conventions.
- Confirm how profile-tab navigation opens Explore programmatically.
- Confirm whether an existing confirmation dialog and safe Markdown renderer can be reused.
- Record any necessary adjustment to this plan before writing feature code.

### Phase 1: query workspace foundation

- Add typed query-tab and workspace models.
- Implement reducer-based workspace operations.
- Add the dataset-scoped workspace provider.
- Add versioned `sessionStorage` loading, validation, debounced saving, and failure recovery.
- Initialize one default query tab using the existing dataset-aware preview SQL.
- Unit test state transitions and malformed persisted data.

### Phase 2: multi-tab Explore editor

- Add the query-tab row and new-tab control.
- Bind the editor to the active tab's SQL.
- Add rename and close interactions.
- Protect modified tabs from accidental closure.
- Preserve each tab's editor content while switching.
- Keep query results associated with the tab that initiated the execution.
- Test switching tabs during an in-flight query and after results return.

### Phase 3: Ask AI sidebar shell

- Register the Ask AI sidebar icon and panel.
- Add suggested prompts, conversation messages, prompt input, and destination selector.
- Add keyboard behavior and accessible labels.
- Add loading, empty, error, unauthorized, and unavailable-service states.
- Add English localization keys following the existing locale structure.

### Phase 4: AI service client

- Add typed request, response, SQL action, source, and error models.
- Call the relative `/ai-service/v1/ask` endpoint with session credentials.
- Validate response shape before exposing it to components.
- Normalize network, authorization, validation, timeout, and service errors.
- Keep the panel usable when the service has not yet been deployed.
- Unit test the transport and response-validation behavior.

### Phase 5: SQL handoff and modification proposals

- Convert valid `CREATE_TAB` actions into new AI query tabs.
- Navigate to Explore and activate the created tab.
- Make repeated **Open in Explore** actions idempotent.
- Show `UPDATE_TAB` actions as proposals rather than immediate mutations.
- Add **Apply changes**, **Create as new tab**, and **Discard** behavior.
- Detect stale or closed target tabs before applying a proposal.
- Add **Copy SQL** without making clipboard access a requirement for the main flow.

### Phase 6: verification and documentation

- Add focused reducer, component, service-client, and integration tests.
- Run the repository-approved frontend formatting, lint, type-check, and test commands.
- Verify the UI at normal and narrow dataset-profile widths.
- Verify keyboard navigation and screen-reader labels.
- Verify existing Summary, Lineage, Columns, Props, and Explore behavior is unchanged.
- Update this document with any contract changes discovered during implementation.

### Phase 7: future service implementation

- Implement the independent AI service and health endpoints.
- Add DataHub authentication and dataset authorization.
- Add metadata retrieval, model orchestration, and approved MCP/tool integration.
- Add structured-output validation and service-side safety limits.
- Add audit, tracing, rate limiting, and operational monitoring.
- Deploy behind the same-origin `/ai-service` proxy path.

## Test strategy

High-value frontend tests include:

- A workspace starts with one dataset-aware query tab.
- SQL remains isolated when switching between tabs.
- Closing the active tab selects a deterministic neighboring tab.
- The last tab cannot leave the workspace empty.
- Invalid persisted state produces a clean workspace instead of crashing.
- A new-tab AI request excludes unrelated query SQL.
- A modify request includes only the selected tab.
- A valid `CREATE_TAB` response creates and activates one tab.
- Reopening the same AI response does not duplicate its tab.
- An `UPDATE_TAB` response cannot modify a different tab.
- A stale update proposal does not overwrite newer user changes.
- Service errors preserve the prompt and all query tabs.
- Generated SQL is never executed without a separate user action.

End-to-end coverage should verify the sidebar-to-Explore handoff with a mocked AI endpoint and the
Explore-to-query-service request with a mocked query endpoint. Tests should focus on user-visible
behavior and security boundaries rather than editor-library implementation details.

## Acceptance criteria

- Ask AI appears as a right-sidebar item on dataset profiles.
- Ask AI receives the exact current dataset URN.
- Explore supports multiple independently editable query tabs.
- A user can create, switch, rename, and close tabs without losing other tab contents.
- AI-generated SQL creates a new tab by default and opens it in Explore.
- A user can explicitly select one tab for an AI modification request.
- Existing tabs are not overwritten without an explicit apply action.
- Generated SQL is never run automatically.
- Ask AI and Explore remain usable while the AI service is unavailable.
- The browser never receives database, model, MCP, or service credentials.
- The query service continues to enforce every execution policy.
- Workspace state is isolated by dataset URN and restored safely during the browser session.
- Existing dataset profile sidebar items and main tabs continue to work.

## Risks and mitigations

- **Nested tabs may be confusing:** call them query tabs, keep them visually inside Explore, and
  preserve the existing dataset-level Explore tab styling.
- **AI may return unsafe SQL:** never auto-run it and keep query-service validation authoritative.
- **AI may overwrite user work:** use new-tab behavior by default and proposal-based updates.
- **A response may arrive after the target changed:** compare the requested tab ID and SQL revision
  before enabling Apply.
- **Browser storage may contain invalid or old data:** version and validate persisted state.
- **Conversation context may grow without bounds:** limit retained messages and let the service
  enforce request-size limits.
- **MCP output may contain prompt injection:** treat it as untrusted input and restrict tools and
  structured output server-side.

## Deferred decisions

- Streaming responses using server-sent events or another transport.
- Persisting conversations across browser sessions.
- Persisting query workspaces per DataHub user.
- Supporting multiple SQL actions in one assistant response.
- Showing SQL diffs instead of a replacement preview.
- Including current query results as optional AI context.
- Adding schema autocomplete and query linting to the editor.
