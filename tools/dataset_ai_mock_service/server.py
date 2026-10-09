#!/usr/bin/env python3

import argparse
import json
import re
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import ClassVar
from uuid import uuid4


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8091
MAX_REQUEST_BYTES = 64 * 1024
ALLOWED_ORIGINS = {
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:9002",
    "http://127.0.0.1:9002",
}
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")


class RequestValidationError(ValueError):
    pass


def require_non_empty_string(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RequestValidationError(f"{field_name} must be a non-empty string")
    return value.strip()


def validate_request(payload: object) -> dict[str, object]:
    if not isinstance(payload, dict):
        raise RequestValidationError("Request body must be a JSON object")

    context = payload.get("context")
    target = payload.get("target")
    if not isinstance(context, dict):
        raise RequestValidationError("context must be an object")
    if not isinstance(target, dict):
        raise RequestValidationError("target must be an object")

    dataset_urn = require_non_empty_string(context.get("datasetUrn"), "context.datasetUrn")
    user_urn = require_non_empty_string(context.get("userUrn"), "context.userUrn")
    question = require_non_empty_string(payload.get("question"), "question")
    mode = require_non_empty_string(target.get("mode"), "target.mode")
    if mode != "NEW_TAB":
        raise RequestValidationError("target.mode must be NEW_TAB")

    conversation_id = payload.get("conversationId")
    if conversation_id is not None and not isinstance(conversation_id, str):
        raise RequestValidationError("conversationId must be a string or null")

    return {
        "context": {"datasetUrn": dataset_urn, "userUrn": user_urn},
        "question": question,
        "conversationId": conversation_id,
        "target": {"mode": "NEW_TAB"},
    }


def dataset_name_from_urn(dataset_urn: str) -> str | None:
    prefix = "urn:li:dataset:(urn:li:dataPlatform:"
    if not dataset_urn.startswith(prefix) or not dataset_urn.endswith(")"):
        return None
    inner = dataset_urn[len(prefix) : -1]
    try:
        _, remainder = inner.split(",", 1)
        dataset_name, _ = remainder.rsplit(",", 1)
    except ValueError:
        return None
    return dataset_name


def sample_sql_for_dataset(dataset_urn: str) -> str:
    dataset_name = dataset_name_from_urn(dataset_urn)
    if not dataset_name:
        return "SELECT 1 AS sample_value;"

    parts = dataset_name.split(".")[-2:]
    if not parts or not all(IDENTIFIER_PATTERN.fullmatch(part) for part in parts):
        return "SELECT 1 AS sample_value;"
    qualified_name = ".".join(f'"{part}"' for part in parts)
    return f"SELECT *\nFROM {qualified_name}\nLIMIT 100;"


def build_response(request: dict[str, object], request_id: str) -> dict[str, object]:
    context = request["context"]
    assert isinstance(context, dict)
    dataset_urn = context["datasetUrn"]
    assert isinstance(dataset_urn, str)

    sql_action: dict[str, object] = {
        "type": "CREATE_TAB",
        "title": "AI sample query",
        "statement": sample_sql_for_dataset(dataset_urn),
        "dialect": "postgresql",
    }

    conversation_id = request.get("conversationId")
    return {
        "requestId": request_id,
        "conversationId": conversation_id if isinstance(conversation_id, str) else f"conversation-{uuid4()}",
        "messageId": f"message-{uuid4()}",
        "answer": "This response came from the local mock AI service. Review the generated SQL before running it.",
        "sqlAction": sql_action,
        "sources": [],
    }


def write_observation(event: str, request_id: str, payload: object) -> None:
    print(
        json.dumps({"event": event, "requestId": request_id, "payload": payload}, separators=(",", ":")),
        flush=True,
    )


class DatasetAiMockHandler(BaseHTTPRequestHandler):
    server_version: ClassVar[str] = "DatasetAiMock/1.0"

    def _write_cors_headers(self) -> None:
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Vary", "Origin")

    def _send_json(self, status: HTTPStatus, payload: dict[str, object]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._write_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self._write_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send_json(HTTPStatus.OK, {"status": "ok"})
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"code": "NOT_FOUND", "message": "Endpoint not found"})

    def do_POST(self) -> None:
        if self.path != "/ai-service/v1/ask":
            self._send_json(HTTPStatus.NOT_FOUND, {"code": "NOT_FOUND", "message": "Endpoint not found"})
            return

        request_id = f"request-{uuid4()}"
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
                raise RequestValidationError("Request body size is invalid")
            raw_body = self.rfile.read(content_length)
            request = validate_request(json.loads(raw_body))
            write_observation("ai_request", request_id, request)
            response = build_response(request, request_id)
            write_observation("ai_response", request_id, response)
            self._send_json(HTTPStatus.OK, response)
        except (json.JSONDecodeError, UnicodeDecodeError, RequestValidationError) as error:
            response = {"code": "INVALID_REQUEST", "message": str(error), "requestId": request_id}
            write_observation("ai_error", request_id, response)
            self._send_json(HTTPStatus.BAD_REQUEST, response)
        except Exception:
            response = {
                "code": "INTERNAL_ERROR",
                "message": "The mock AI service could not process the request",
                "requestId": request_id,
            }
            write_observation("ai_error", request_id, response)
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, response)

    def log_message(self, format: str, *args: object) -> None:
        return


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the local dataset Ask AI mock service")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    server = ThreadingHTTPServer((args.host, args.port), DatasetAiMockHandler)
    print(f"Dataset AI mock service listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    try:
        main()
    except OSError as error:
        print(f"Unable to start mock service: {error}", file=sys.stderr)
        raise SystemExit(1) from error
