# DataHub Ask AI service

A small FastAPI service that runs a DeepAgents assistant and owns private, user-scoped
conversation history. Messages, titles, SQL actions and source references persist in SQLite.
A conversation can span datasets: each turn records the dataset selected when it was sent.
The active chat and draft survive dataset navigation; saved conversations can be reopened,
renamed or deleted.

## Configure and start

1. Copy `config.example.json` to `config.local.json` and set `model` to a LangChain
   `provider:model` identifier supported by DeepAgents. The bundled integrations support
   Anthropic and Google. Additional providers need their LangChain integration installed
   in the service image.
2. Store the model API key in a file outside the repository. The service reads that file
   and passes the key directly into the model constructor. It never writes credentials
   into the process environment.
3. Configure paths through the development wrapper:

   ```bash
   scripts/dev/datahub-dev.sh env set DATAHUB_AI_SERVICE_CONFIG_FILE=/absolute/path/config.local.json
   scripts/dev/datahub-dev.sh env set DATAHUB_AI_MODEL_API_KEY_FILE=/absolute/path/model-api-key
   scripts/dev/datahub-dev.sh start --ask-ai
   ```

The wrapper creates a random proxy signing secret when none is configured. The model-key
file must be readable by the container's `datahub` user (UID 1000). The default config leaves
`model` empty: history APIs remain usable, while asking a question returns `AI_UNCONFIGURED`.
`/health` reports process health; `/ready` also checks that the model is configured.

The container exposes port 8091 only to the internal network. Browser requests use
`/ai-service/v1/...` through the authenticated DataHub frontend proxy, including during Vite
development. `start --ai --ask-ai` also starts the existing embedding-service profile.
Use `scripts/dev/datahub-dev.sh setup ai-service` to prepare local development dependencies.
Source changes reload automatically in the development container.

For deployment outside the development stack, build the Dockerfile in
`docker/datahub-ai-service/`, mount configuration and the model-key file, and provision the
same `DATAHUB_AI_SERVICE_PROXY_SECRET` (at least 32 random characters) on the frontend and AI
service. Mount a persistent volume at `/var/lib/datahub-ai`. This first version uses a local
SQLite volume and is intended for a single service instance; a future shared database can
replace the conversation repository for distributed deployments.

## Conversation API

All conversation endpoints require the trusted frontend proxy. Identity comes from the
verified session, never from a browser-supplied user URN. HMAC signatures bind the actor,
authorization token, timestamp, HTTP method, path, query and exact request body.

| Browser endpoint                                   | Behavior                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `POST /ai-service/v1/conversations`                | Create an empty conversation                                       |
| `GET /ai-service/v1/conversations?offset=0`        | List the user's saved chats, newest first; returns `nextOffset`    |
| `GET /ai-service/v1/conversations/{id}?before=100` | Load up to 100 messages; returns `nextBefore` for earlier messages |
| `PATCH /ai-service/v1/conversations/{id}`          | Rename with `{ "title": "My analysis" }`                           |
| `DELETE /ai-service/v1/conversations/{id}`         | Delete the conversation and its messages                           |
| `DELETE /ai-service/v1/conversations`              | Delete all conversations belonging to the authenticated user       |
| `POST /ai-service/v1/ask`                          | Save a question, invoke DeepAgents and save the reply              |

An ask request includes `context.datasetUrn`, `question`, `conversationId`, a UUID `requestId`
and `target: { "mode": "NEW_TAB" }`. The request ID must remain stable for a retry. Successful
responses retain `conversationId`, `messageId`, `answer`, `sqlAction` and `sources`, and include
`conversation`, `userMessage` and `assistantMessage` so the UI can reconcile saved records.
See `src/datahub_ai_service/models.py` for the complete contract.

The first question provides an immediate fallback title. The first successful answer can
supply a short title; an explicit rename is never overwritten. New chat preserves earlier
history. Logout and closing the panel preserve backend history but clear access to another
user's in-memory state. Deletion permanently removes local records and invalidates pending
replies; it does not change separate provider or backup retention policies.

## Agent behavior and limits

The initial agent resolves the current dataset's schema and description through DataHub
using the authenticated user's token. Dataset view permissions are checked before metadata
retrieval, before reusing historical context, when loading messages and before saving a reply.
Generated SQL remains a draft: Ask AI cannot execute it. SQL actions retain their dataset so
an old reply cannot populate the wrong dataset's Explore workspace.

DeepAgents uses an ephemeral state backend with no host filesystem or shell execution and no
persistent checkpoints. The conversation repository is the sole durable chat store. Tool
state is not shared between invocations. No custom MCP, search or database-execution tools
are installed in this initial agent.

The model receives recent completed user/assistant turns within a configurable character
budget. Full history remains paginated in storage. Failed turns are excluded from model
context and can be retried without duplicate messages. One reply may be pending per chat;
leases recover interrupted requests, and a late result cannot overwrite a newer retry.
Request/response sizes, concurrent requests, model recursion and total reply duration are
bounded. Prompts, SQL, credentials and tool traces are not logged or sent to LangSmith.

## Verify

```bash
./gradlew :datahub-ai-service:lintFix
./gradlew :datahub-ai-service:lint :datahub-ai-service:test
./gradlew :datahub-web-react:yarnAskAiFormat :datahub-web-react:yarnAskAiLintFix
./gradlew :datahub-web-react:yarnTest -PtestFile=src/app/entityV2/shared/sidebarSection/AskAi
./gradlew :datahub-web-react:yarnTypeCheck
./gradlew :datahub-frontend:test --tests controllers.AiServiceControllerTest
```

Backend tests use a real temporary SQLite database and a DeepAgents graph with a local test
model. They require neither a running DataHub stack nor paid model calls.
