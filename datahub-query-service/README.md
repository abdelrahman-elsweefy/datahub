# DataHub Query Service

A standalone Python service for the Explore SQL editor. Users choose a database connection;
the current dataset selects the initial connection when an unambiguous match exists. Queries
may read any table accessible to that connection's shared read-only database account.

The first adapter supports PostgreSQL. The execution adapter and credential provider are
separate interfaces so additional databases or per-user credentials can be added later.

## Configure connections

Copy `connections.example.json` to `connections.local.json` and add your connections. The
local file and `secrets/` contents are ignored by Git. Use generic placeholders in committed
examples; keep actual deployment identifiers and credentials in the local configuration.

```json
{
  "connections": [
    {
      "id": "analytics-dev",
      "label": "Analytics — Development",
      "platform": "postgres",
      "host": "host.docker.internal",
      "port": 5432,
      "database": "my_db",
      "username": "query_reader",
      "passwordFile": "/run/secrets/query-service/analytics-password",
      "sslmode": "verify-full",
      "defaultSchema": "public",
      "environment": "DEV",
      "allowedUserUrns": ["urn:li:corpuser:user1"]
    }
  ],
  "maxRows": 100,
  "maxResultBytes": 4194304,
  "timeoutSeconds": 30,
  "maxConcurrentQueries": 10,
  "poolSize": 4,
  "datahubGraphqlUrl": "http://datahub-gms:8080/api/graphql"
}
```

Put the database password in `secrets/analytics-password`. Passwords are read from files and
passed directly to the driver; they are never put in the process environment or sent to the
browser. Make these files readable by the container's UID 10001 while restricting host access.
For a local PostgreSQL server without TLS, explicitly use `sslmode: disable`; production
connections default to verified TLS. Mount a CA certificate and configure `sslrootcert` if needed.

Provision a database role with `CONNECT`, schema `USAGE`, and `SELECT` on the intended tables
and views. Include grants for future tables created by each relevant owner. The role should
have no write, schema creation, superuser, role administration, or row-security bypass rights.
All users allowed to use a connection share that role's table and row access.

Access defaults to denied. `allowedUserUrns` grants a connection to specific authenticated
DataHub users. To intentionally share it with every signed-in user, set
`allowAllAuthenticatedUsers: true`.

Default connection matching uses the dataset's platform, platform-instance URN, environment,
and database prefix. Configure `platformInstanceUrn` when ingestion uses platform instances.
An optional `datasetUrns` list provides explicit matches for nonstandard dataset names.
Both paths require a successful dataset metadata lookup using the user's session token.
Missing, inaccessible, ambiguous, or unavailable metadata leaves the dropdown unselected.
The chosen connection is authoritative when executing; the dataset URN is only context.

## Run with DataHub

The standard `debug` and `quickstart` Compose profiles include the service. The development
wrapper generates and persists a random proxy signing secret for both the frontend and service.
Database credentials are not generated automatically.

```sh
scripts/dev/datahub-dev.sh env set DATAHUB_QUERY_SERVICE_CONFIG=/absolute/path/to/connections.local.json
scripts/dev/datahub-dev.sh env set DATAHUB_QUERY_SERVICE_SECRETS_DIR=/absolute/path/to/secrets
scripts/dev/datahub-dev.sh start
scripts/dev/datahub-dev.sh status
```

For an existing instance, apply configuration changes with
`scripts/dev/datahub-dev.sh env restart`. Python source reloads automatically in the debug
profile. Use `scripts/dev/datahub-dev.sh rebuild --module query-service --wait` for development;
dependency/image changes require `env restart` to recreate the service from the rebuilt image.

The service is internal to the Compose network. The frontend's same-origin `/query-service`
proxy works with both the packaged UI and the frontend development server.

For other deployments, set `DATAHUB_QUERY_SERVICE_URL` on the frontend, and provide the same
random `DATAHUB_QUERY_SERVICE_PROXY_SECRET` of at least 32 characters to both services. Set
`DATAHUB_QUERY_SERVICE_CONFIG` to the service's mounted configuration file. Configure the GMS
GraphQL URL including its deployment base path. Keep the service behind the trusted proxy.

## API and execution policy

- `GET /query-service/v1/connections?datasetUrn=...` returns accessible connection summaries,
  `defaultConnectionId`, and `maxRows`.
- `POST /query-service/v1/query` accepts `{ "connectionId": "analytics-dev", "datasetUrn": "...", "sql": "SELECT ..." }`.
- Execution returns `columns`, `rows`, `rowCount`, `executionTimeMs`, `truncated`, `queryId`,
  and `connectionId`. `rowCount` counts returned rows, not a separate full-table count.
- Errors contain a safe `message` and `code` with an appropriate HTTP status.
- Internal `/health` is liveness; `/ready` requires configured connections and password files.
  The frontend exposes liveness at `/query-service/health` for the development wrapper.

The frontend verifies its signed session and creates a short-lived HMAC assertion bound to
the user, method, path, token, and exact request body. Incoming identity/signature headers
are never forwarded from the browser. The Python service verifies the assertion and checks
connection access on every execution. Bearer tokens alone do not authorize direct calls.

SQL must be a single SELECT, including read-only CTEs, joins, and aggregates. Write CTEs,
SELECT INTO, locking clauses, non-approved functions, and custom casts/operators are rejected.
Approved functions and casts are explicitly qualified into `pg_catalog`. Execution also uses
a read-only transaction, server timeout, lock timeout, bounded connection pools, a concurrency
limit, a server-side cursor, row limits, and a response byte budget. Duplicate output names
must use distinct `AS` aliases. Decimal and large integer values are strings to preserve
precision; timestamps use ISO format and binary values use base64.

Audit logs contain user, connection ID, query ID, outcome, duration, and returned row count.
They exclude SQL, result values, tokens, and database credentials. Browser aborts clear the
client request; the database deadline bounds execution even if the proxy keeps its request open.

## Verify

```sh
./gradlew :datahub-query-service:lintFix
./gradlew :datahub-query-service:lint :datahub-query-service:test
./gradlew :datahub-web-react:yarnTest -PtestFile=src/app/entityV2/shared/tabs/Dataset/Explore
./gradlew :datahub-frontend:test --tests controllers.QueryServiceControllerTest
```

The database integration test needs `QUERY_SERVICE_TEST_DATABASE_URL` for a disposable
PostgreSQL database with a password. Run it with
`./gradlew :datahub-query-service:testIntegration`. It verifies real cursor truncation,
empty results, duplicate aliases, timeout cleanup, read-only enforcement, and pool recovery.
