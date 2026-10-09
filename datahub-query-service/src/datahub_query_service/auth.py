import hashlib
import hmac
import time
from dataclasses import dataclass

from fastapi import Request

from datahub_query_service.errors import QueryError


@dataclass(frozen=True)
class AuthenticatedUser:
    actor_urn: str
    authorization: str | None


async def authenticate(request: Request, secret: str) -> AuthenticatedUser:
    actor = request.headers.get("X-DataHub-Query-Actor", "")
    timestamp = request.headers.get("X-DataHub-Query-Timestamp", "")
    signature = request.headers.get("X-DataHub-Query-Signature", "")
    try:
        timely = abs(time.time() - int(timestamp)) <= 30
    except ValueError:
        timely = False
    if (
        len(secret) < 32
        or not timely
        or not actor.startswith("urn:li:corpuser:")
        or "\n" in actor
    ):
        raise QueryError(401, "UNAUTHENTICATED", "Sign in to run queries.")
    body = await request.body()
    path = request.url.path
    if request.url.query:
        path += "?" + request.url.query
    authorization = request.headers.get("Authorization", "")
    # Bind the identity, method, URL, token and exact body so a signature cannot authorize another query.
    payload = "\n".join(
        (
            timestamp,
            actor,
            request.method,
            path,
            hashlib.sha256(body).hexdigest(),
            hashlib.sha256(authorization.encode()).hexdigest(),
        )
    )
    expected = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected.encode(), signature.encode()):
        raise QueryError(401, "UNAUTHENTICATED", "Sign in to run queries.")
    return AuthenticatedUser(actor_urn=actor, authorization=authorization or None)
