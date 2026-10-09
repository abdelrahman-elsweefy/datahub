import json
import time

from conftest import RecordingAdapter, signed_headers
from fastapi.testclient import TestClient

from datahub_query_service.app import create_app
from datahub_query_service.config import ServiceConfig


def test_selected_connection_overrides_dataset_context(config: ServiceConfig) -> None:
    adapter = RecordingAdapter()
    body = json.dumps(
        {
            "connectionId": "reporting",
            "datasetUrn": "urn:li:dataset:(urn:li:dataPlatform:postgres,my_db.public.events,PROD)",
            "sql": "SELECT * FROM public.other_events",
        }
    ).encode()
    with TestClient(create_app(config, adapter)) as client:
        response = client.post(
            "/v1/query", content=body, headers=signed_headers("POST", "/v1/query", body)
        )
    assert response.status_code == 200
    assert response.json()["connectionId"] == "reporting"
    assert response.headers["Cache-Control"] == "no-store"
    assert adapter.executions == ["reporting"]


def test_connection_list_filters_access_and_hides_credentials(
    config: ServiceConfig,
) -> None:
    with TestClient(create_app(config, RecordingAdapter())) as client:
        response = client.get(
            "/v1/connections", headers=signed_headers("GET", "/v1/connections")
        )
    assert response.status_code == 200
    assert [item["id"] for item in response.json()["connections"]] == [
        "analytics",
        "reporting",
    ]
    assert "password" not in response.text
    assert "username" not in response.text
    assert "host" not in response.text
    assert response.json()["defaultConnectionId"] is None


def test_unauthorized_connection_does_not_execute(config: ServiceConfig) -> None:
    adapter = RecordingAdapter()
    body = b'{"connectionId":"restricted","sql":"SELECT 1"}'
    with TestClient(create_app(config, adapter)) as client:
        response = client.post(
            "/v1/query", content=body, headers=signed_headers("POST", "/v1/query", body)
        )
    assert response.status_code == 403
    assert not adapter.executions


def test_write_query_is_rejected_before_execution(config: ServiceConfig) -> None:
    adapter = RecordingAdapter()
    body = b'{"connectionId":"analytics","sql":"WITH changed AS (DELETE FROM events RETURNING *) SELECT * FROM changed"}'
    with TestClient(create_app(config, adapter)) as client:
        response = client.post(
            "/v1/query", content=body, headers=signed_headers("POST", "/v1/query", body)
        )
    assert response.status_code == 400
    assert not adapter.executions


def test_forged_expired_and_modified_requests_are_rejected(
    config: ServiceConfig,
) -> None:
    adapter = RecordingAdapter()
    body = b'{"connectionId":"analytics","sql":"SELECT 1"}'
    with TestClient(create_app(config, adapter)) as client:
        assert (
            client.post(
                "/v1/query",
                content=body,
                headers={
                    "Content-Type": "application/json",
                    "X-DataHub-Query-Actor": "urn:li:corpuser:user1",
                },
            ).status_code
            == 401
        )
        assert (
            client.post(
                "/v1/query",
                content=body,
                headers=signed_headers(
                    "POST", "/v1/query", body, timestamp=int(time.time()) - 60
                ),
            ).status_code
            == 401
        )
        assert (
            client.post(
                "/v1/query",
                content=body.replace(b"SELECT 1", b"SELECT 2"),
                headers=signed_headers("POST", "/v1/query", body),
            ).status_code
            == 401
        )
    assert not adapter.executions
