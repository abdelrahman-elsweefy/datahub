from datetime import datetime
from decimal import Decimal

from datahub_query_service.execution import serialize_value


def test_preserves_precision_and_serializes_database_values() -> None:
    assert serialize_value(2**63 - 1) == "9223372036854775807"
    assert (
        serialize_value(Decimal("123.450000000000000001")) == "123.450000000000000001"
    )
    assert serialize_value(datetime(2026, 1, 1)) == "2026-01-01T00:00:00"
    assert serialize_value({"items": [None, True, b"abc"]}) == {
        "items": [None, True, "YWJj"]
    }
