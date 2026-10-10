import hashlib
import hmac
import time
from dataclasses import dataclass

from fastapi import Request

from datahub_ai_service.errors import AiError


@dataclass(frozen=True)
class AuthenticatedUser:
    actor_urn: str
    authorization: str


async def authenticate(request: Request, secret: str) -> AuthenticatedUser:
    actor = request.headers.get("X-DataHub-AI-Actor", "")
    timestamp = request.headers.get("X-DataHub-AI-Timestamp", "")
    signature = request.headers.get("X-DataHub-AI-Signature", "")
    authorization = request.headers.get("Authorization", "")
    try:
        timely = abs(time.time() - int(timestamp)) <= 30
    except ValueError:
        timely = False
    if (
        len(secret) < 32
        or not timely
        or not actor.startswith("urn:li:corpuser:")
        or "\n" in actor
        or not authorization
    ):
        raise AiError(401, "UNAUTHENTICATED", "Sign in to use Ask AI.")
    path = request.url.path
    if request.url.query:
        path += "?" + request.url.query
    body = await request.body()
    # Bind identity to the exact method, URL, token and body rather than trusting
    # browser headers.
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
    if not hmac.compare_digest(expected, signature):
        raise AiError(401, "UNAUTHENTICATED", "Sign in to use Ask AI.")
    return AuthenticatedUser(actor_urn=actor, authorization=authorization)
