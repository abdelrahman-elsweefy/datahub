# Dataset Ask AI and Query Workspace Plan

## Status

Implemented with a frontend and an independent DeepAgents AI service with private, persistent
conversation history. Conversations belong to the user and continue across dataset navigation;
each message retains its dataset context. See
[`datahub-ai-service/README.md`](../../datahub-ai-service/README.md) for configuration and API details.

The interaction was simplified after UI review: Ask AI no longer targets or overwrites existing query tabs. Every structured SQL
response stays in the conversation until the user selects **Open in Explore**.

This design extends the dataset Explore experience described in
[`dataset-explore-ui-plan.md`](dataset-explore-ui-plan.md). Explore remains responsible for editing
and running SQL, while a new **Ask AI** dataset sidebar tab helps users understand an asset and
create or revise queries. Query execution and AI processing remain separate services outside
DataHub's GMS. Users who want AI to revise SQL paste that SQL into the prompt; the revised result
can then be opened in a new query tab.

## Goals

- Add an **Ask AI** icon to the dataset profile's right vertical sidebar.
- Give non-technical users a conversational way to ask questions about the current data asset.
- Turn Explore into a multi-tab SQL workspace.
- Create a new query tab when the user opens AI-generated SQL in Explore.
- Let users paste existing SQL into the prompt when they want a revision.
- Keep generated SQL reviewable and require the user to run it explicitly.
- Keep the frontend independent of a specific model, MCP server, or tool provider.
- Preserve the existing query-service security boundary.

## Non-goals for the first version

- Executing SQL from the Ask AI panel.
- Allowing AI to modify or overwrite an existing query tab.
- Saving query workspaces to a DataHub backend. Ask AI conversations are saved in the independent AI service.
- Sharing query workspaces between users.
- Building the AI/MCP service as part of the DataHub GMS.
- Exposing database credentials, MCP credentials, or model credentials to the browser.
- Allowing generated write statements to bypass the query service's read-only validation.

## User experience

### Ask AI sidebar

The right vertical sidebar gains an **Ask AI** item with a sparkles or assistant icon. Selecting it
opens a panel in the same area used by Summary, Lineage, Columns, and Props.

The panel contains:

- One **Ask AI** heading supplied by the sidebar, with a short explanation directly beneath it.
- Suggested prompts when the conversation is empty.
- A scrollable conversation history.
- A multiline prompt field.
- An **Ask** button.
- Loading, unavailable-service, authorization, and recoverable error states.

Pressing `Enter` submits a non-empty prompt. Pressing `Shift+Enter` inserts a newline. The Ask
button is disabled while a request is running.

### New-tab-only SQL handoff

Every request uses the `NEW_TAB` target. The frontend never reads or sends the contents of existing
query tabs automatically. When a user wants to revise a query, they paste the SQL into the prompt;
that pasted text is sent as part of `question`. Returned SQL remains in the conversation until the
user selects **Open in Explore**. This keeps existing work untouched and removes
destination-selection complexity from the panel.

### AI-generated SQL

When the service returns SQL, the frontend displays it in the conversation with **Open in Explore**
and **Copy SQL** actions. It does not create or activate a query tab automatically.

When the user selects **Open in Explore**, the frontend:

1. Creates a new query tab with a generated, editable title.
2. Stores the returned SQL in that tab.
3. Marks its source as AI.
4. Makes the new tab active.
5. Navigates the dataset's main content to Explore.
6. Leaves execution to the user.

Repeated activation of **Open in Explore** focuses the already-created tab instead of creating a
duplicate.

### Revising SQL

The user may paste SQL into the multiline prompt together with instructions such as "add a
seven-day filter." The full prompt is sent to the AI service as user-authored text. A structured SQL
response follows the same user-triggered new-tab handoff as every other generated query; it never
mutates the source tab.

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
right sidebar. This allows Ask AI to create a query tab after **Open in Explore** is selected, even
when Explore is not currently selected.

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
  "context": {
    "datasetUrn": "urn:li:dataset:(urn:li:dataPlatform:postgres,my_db.my_schema.events,PROD)"
  },
  "question": "Add a seven-day filter to this query:\nSELECT event_date, COUNT(*) FROM my_schema.events GROUP BY event_date",
  "conversationId": null,
  "requestId": "11111111-1111-4111-8111-111111111111",
  "target": {
    "mode": "NEW_TAB"
  }
}
```

Successful response (core fields; the service also returns the saved `conversation`,
`userMessage` and `assistantMessage` records):

```json
{
  "conversationId": "conversation-123",
  "messageId": "message-456",
  "answer": "I added a seven-day filter while preserving the daily grouping.",
  "sqlAction": {
    "type": "CREATE_TAB",
    "title": "Daily events - last 7 days",
    "statement": "SELECT event_date, COUNT(*) FROM my_schema.events WHERE event_date >= CURRENT_DATE - INTERVAL '7 days' GROUP BY event_date",
    "dialect": "postgresql"
  },
  "sources": []
}
```

`sqlAction` is optional because some questions require only a natural-language answer. The first
version accepts at most one `CREATE_TAB` SQL action per response. The frontend never extracts
executable SQL from Markdown; it uses only `sqlAction.statement`. Other action types are ignored,
while the safe explanatory answer is still displayed when possible.

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

The independent service handles authentication, dataset access, schema retrieval, DeepAgents
invocation and private conversation persistence. Approved MCP tools can be added later. Its
responsibilities are:

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
validation, connection access, row limits, timeouts, and user authorization.

## Security and privacy boundaries

- AI-generated SQL is untrusted input.
- Generated SQL is never run automatically.
- The query service must validate AI-generated SQL exactly like user-written SQL.
- The browser never reads or sends existing query-tab SQL automatically. SQL is included only when
  the user explicitly pastes it into the prompt.
- Database credentials and connection strings never enter browser state.
- The frontend renders assistant text through safe Markdown components with raw HTML disabled.
- Tool traces are not rendered unless the service returns an approved, user-facing source model.
- Dataset access revocation must be enforced by both AI and query services on every request.
- A model response cannot choose or overwrite an existing tab; only `CREATE_TAB` actions are
  accepted.

## Component boundaries

The implementation should keep these responsibilities separate:

- `DatasetQueryWorkspaceProvider`: tab state, persistence, and workspace actions.
- `QueryTabBar`: tab creation, selection, rename, close, and modified indicators.
- `ExploreTab`: editor and query results for the active query tab.
- `AskAiSidebarTab`: conversation UI and new-tab SQL handoff.
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
- Add one sidebar heading, an explanatory sentence, suggested prompts, conversation messages, and
  prompt input.
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

### Phase 5: SQL handoff

- Convert valid `CREATE_TAB` actions into new AI query tabs.
- Wait for **Open in Explore** before creating, activating, or navigating to a tab.
- Make repeated **Open in Explore** actions idempotent.
- Ignore response actions that attempt to update an existing tab.
- Let users request revisions by pasting SQL into the prompt; keep the result in a new tab.
- Add **Copy SQL** without making clipboard access a requirement for the main flow.

### Phase 6: verification and documentation

- Add focused reducer, component, service-client, and integration tests.
- Run the repository-approved frontend formatting, lint, type-check, and test commands.
- Verify the UI at normal and narrow dataset-profile widths.
- Verify keyboard navigation and screen-reader labels.
- Verify existing Summary, Lineage, Columns, Props, and Explore behavior is unchanged.
- Update this document with any contract changes discovered during implementation.

### Phase 7: AI service and conversation persistence

- Implement the independent DeepAgents AI service and health endpoints.
- Persist user-owned titled conversations and per-message dataset context.
- Keep the active chat and draft above dataset navigation; restore history from the backend.
- Provide saved-chat selection, rename, deletion and clear-all controls.
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
- An AI request excludes unrelated query-tab SQL.
- Pasted SQL remains part of the exact user-authored `question`.
- A valid `CREATE_TAB` response does not alter the workspace until **Open in Explore** is selected.
- Selecting **Open in Explore** creates and activates one tab.
- Reopening the same AI response does not duplicate its tab.
- An `UPDATE_TAB` response is ignored and cannot overwrite existing work.
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
- AI-generated SQL stays in Ask AI until the user selects **Open in Explore**.
- **Open in Explore** creates a new tab and activates it.
- A user can paste SQL into the prompt to request a revision.
- Existing tabs are never overwritten by Ask AI.
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
- **AI may overwrite user work:** accept only new-tab actions and never mutate existing tabs.
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
