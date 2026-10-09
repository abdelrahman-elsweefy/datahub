# Dataset Explore UI and Query Service Plan

## Decision

Add an **Explore** tab to dataset profiles and keep query execution outside DataHub's GMS. The
frontend calls a separately deployed query service through a same-origin reverse-proxy path. This
keeps database drivers, credentials, SQL validation, and query execution out of the DataHub
backend and avoids coupling the service lifecycle to DataHub builds.

The Python implementation now lives in `datahub-query-service/`. See its
[`README`](../../datahub-query-service/README.md) for configuration, deployment, execution
policies, and verification commands. PostgreSQL is the first supported adapter.

## User experience

The Explore tab supports five UI states:

1. **Ready**: a SQL editor is prefilled with a small read-only query for the current dataset.
2. **Running**: the editor remains visible while the results area shows progress and the run button
   is disabled.
3. **Results**: returned columns and rows are rendered in a scrollable table with execution
   metadata and truncation status.
4. **Empty results**: a successful query with no rows receives a distinct, non-error state.
5. **Error**: authorization, validation, unavailable-service, and execution failures are presented
   without losing the user's SQL.

The first version intentionally excludes query history, saved queries, downloads, schema
autocomplete, and data mutation. Users may query and
join any tables accessible to the selected connection's shared read-only account. A dropdown
defaults from the current dataset URN when a unique accessible connection can be resolved.
Connections are stored per query tab. Changing connections preserves SQL, clears previous
results, and requires a separate Run action. Results show the connection that produced them.

## Frontend-to-service contract

The browser sends a request to the relative endpoint below. A deployment can route that path to a
standalone service without changing the frontend or enabling cross-origin requests.

```http
POST /query-service/v1/query
Content-Type: application/json

{
  "connectionId": "analytics-prod",
  "datasetUrn": "urn:li:dataset:(urn:li:dataPlatform:postgres,my_db.my_schema.my_table,PROD)",
  "sql": "SELECT * FROM my_schema.my_table LIMIT 100"
}
```

Successful response:

```json
{
  "columns": [
    { "name": "id", "type": "integer" },
    { "name": "created_at", "type": "timestamp" }
  ],
  "rows": [{ "id": 1, "created_at": "2026-01-01T10:00:00Z" }],
  "rowCount": 1,
  "executionTimeMs": 24,
  "truncated": false,
  "connectionId": "analytics-prod",
  "queryId": "optional-audit-id"
}
```

Errors use an HTTP status plus a safe user-facing message:

```json
{
  "message": "Only read-only SELECT statements are allowed",
  "code": "QUERY_NOT_READ_ONLY"
}
```

The frontend also accepts `detail` instead of `message` so the future service can use conventional
FastAPI error responses.

## Authentication and authorization

- The browser sends same-origin session credentials. It never sends database credentials.
- The service derives the authenticated identity from the trusted proxy/session integration.
- The service authorizes the identity against the chosen connection before opening a database
  connection.
- The temporary shared database user belongs only in the query service configuration. It must not
  be included in frontend configuration or responses.
- A future LDAP rollout changes identity resolution and database credential selection inside the
  service; the frontend contract remains unchanged.

The execution target is now the explicit `connectionId`; `datasetUrn` supplies context for
default selection. Discovery uses `GET /query-service/v1/connections?datasetUrn=...` and exposes
only accessible connection summaries. Execution checks connection access on every request.
The authenticated frontend session is forwarded as a short-lived signed assertion bound to
the identity, method, path, token, and body. The Python service rejects unsigned requests.

## Service responsibilities

The standalone service will:

1. Validate the connection ID and the dataset URN used for default discovery.
2. Resolve the default connection from DataHub metadata and server-side connection configuration.
3. Verify the user can use the chosen connection.
4. Accept only a single read-only statement against the chosen connection, using that account's database permissions.
5. Apply a server-side row limit, timeout, concurrency limit, and result-size limit.
6. Select a platform adapter and obtain credentials from server-side configuration or the future
   user credential provider.
7. Execute with a read-only database transaction where supported.
8. Audit user, dataset URN, query ID, outcome, duration, and row count without logging secrets or
   unrestricted result data.

The service is authoritative for every security limit. Frontend controls are usability features,
not security boundaries.

## Delivery phases

### Phase 1: UI shell

- Add the Explore dataset tab.
- Add the editor, run and clear controls, result table, loading state, empty state, and error state.
- Call the relative service endpoint using the documented contract.
- Keep failures recoverable so the UI can be developed before the service exists.

### Phase 2: PostgreSQL service

- Implement metadata resolution and a PostgreSQL adapter.
- Add connection discovery, per-tab selection, and connection access rules.
- Configure one least-privilege read-only database user outside source control.
- Enforce statement, asset, limit, timeout, and authorization policies server-side.
- Add health/readiness endpoints and structured audit logs.

### Phase 3: production identity

- Put the service behind the same trusted authentication boundary as DataHub.
- Integrate LDAP/SSO identity and DataHub policy checks.
- Select per-user or delegated database credentials when required.
- Add rate limiting, cancellation, observability, and operational dashboards.

### Phase 4: additional platforms

- Introduce adapters only after PostgreSQL behavior and policy boundaries are stable.
- Keep connection discovery and dialect-specific SQL validation behind adapter interfaces.
- Add platform-specific integration tests before enabling each adapter.

## Acceptance criteria for the UI phase

- Explore appears on dataset profiles and receives the current dataset URN from entity context.
- Run is disabled for blank SQL and while a query is executing.
- The request uses the exact current dataset URN and never includes connection information.
- Success, empty, truncation, authorization, validation, and unavailable-service states are clear.
- Arbitrary JSON-compatible values render safely in the result table.
- The UI follows DataHub theme tokens and remains usable at narrow content widths.
