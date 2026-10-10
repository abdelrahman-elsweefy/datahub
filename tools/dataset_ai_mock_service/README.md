# Dataset Ask AI Mock Service

This is the legacy frontend-contract prototype. The persistent Ask AI UI uses
[`datahub-ai-service`](../../datahub-ai-service/README.md); this mock does not support its
conversation APIs and should not be used for saved-chat development.

This dependency-free development service validates the dataset Ask AI frontend contract. It logs
structured request and response payloads to its terminal and returns explanatory text plus sample
SQL. It does not call a model, MCP server, database, or DataHub API.

The mock accepts only the `NEW_TAB` target. To validate a revision workflow, include the existing
SQL directly in `question`; the response still returns a `CREATE_TAB` action.

## Run

From the repository root:

```bash
metadata-ingestion/venv/bin/python tools/dataset_ai_mock_service/server.py
```

The service listens on `http://127.0.0.1:8091` by default.

```bash
curl http://127.0.0.1:8091/health
```

## Example request

```bash
curl -X POST http://127.0.0.1:8091/ai-service/v1/ask \
  -H "Content-Type: application/json" \
  -d '{
    "context": {
      "datasetUrn": "urn:li:dataset:(urn:li:dataPlatform:postgres,my_db.my_schema.events,PROD)",
      "userUrn": "urn:li:corpuser:user1"
    },
    "question": "Improve this query:\nSELECT * FROM my_schema.events",
    "conversationId": null,
    "target": { "mode": "NEW_TAB" }
  }'
```

Each request produces `ai_request` and `ai_response` JSON log lines sharing the same request ID.
The service deliberately does not inspect or log cookies, authorization headers, or credentials.
