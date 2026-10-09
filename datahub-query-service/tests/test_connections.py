import httpx
from conftest import ACTOR

from datahub_query_service.auth import AuthenticatedUser
from datahub_query_service.config import ServiceConfig
from datahub_query_service.connections import ConnectionRegistry

DATASET_URN = "urn:li:dataset:(urn:li:dataPlatform:postgres,my_db.public.events,PROD)"


async def test_default_matches_database_environment_and_instance(
    config: ServiceConfig,
) -> None:
    def metadata(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer user-token"
        return httpx.Response(
            200,
            json={
                "data": {
                    "dataset": {
                        "name": "events",
                        "platform": {"name": "postgres"},
                        "dataPlatformInstance": None,
                    }
                }
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(metadata)) as client:
        registry = ConnectionRegistry(config, client)
        user = AuthenticatedUser(actor_urn=ACTOR, authorization="Bearer user-token")
        assert (
            await registry.list_for(user, DATASET_URN)
        ).default_connection_id == "analytics"
        config.connections[0].environment = "DEV"
        assert (
            await registry.list_for(user, DATASET_URN)
        ).default_connection_id is None
        config.connections[0].environment = "PROD"
        config.connections[
            0
        ].platform_instance_urn = "urn:li:dataPlatformInstance:other"
        assert (
            await registry.list_for(user, DATASET_URN)
        ).default_connection_id is None


async def test_ambiguous_and_unavailable_metadata_leave_default_unselected(
    config: ServiceConfig,
) -> None:
    config.connections[1].database = "my_db"

    def metadata(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": {
                    "dataset": {
                        "name": "my_db.public.events",
                        "platform": {"name": "postgres"},
                    }
                }
            },
        )

    user = AuthenticatedUser(actor_urn=ACTOR, authorization=None)
    async with httpx.AsyncClient(transport=httpx.MockTransport(metadata)) as client:
        result = await ConnectionRegistry(config, client).list_for(user, DATASET_URN)
        assert len(result.connections) == 2
        assert result.default_connection_id is None
    async with httpx.AsyncClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(503))
    ) as client:
        result = await ConnectionRegistry(config, client).list_for(user, DATASET_URN)
        assert len(result.connections) == 2
        assert result.default_connection_id is None
