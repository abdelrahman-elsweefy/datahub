import pytest

from datahub_query_service.errors import QueryError
from datahub_query_service.validation import validate_query


@pytest.mark.parametrize(
    "statement",
    [
        "SELECT * FROM public.events; -- trailing comment",
        "WITH recent AS (SELECT * FROM events) SELECT count(*) FROM recent",
        "SELECT a.id, count(*) FROM public.events a JOIN public.users b ON a.id = b.id GROUP BY a.id",
        "SELECT 'DELETE; SELECT' AS example, created_at::date FROM events",
        "SELECT * FROM events UNION ALL SELECT * FROM archived_events",
    ],
)
def test_accepts_read_only_queries(statement: str) -> None:
    assert validate_query(statement)


def test_builtin_functions_are_schema_qualified() -> None:
    assert "pg_catalog.lower" in validate_query("SELECT lower('VALUE')")


@pytest.mark.parametrize(
    "statement",
    [
        "DELETE FROM events",
        "SELECT 1; SELECT 2",
        "COPY events TO STDOUT",
        "SELECT * INTO copied_events FROM events",
        "SELECT * FROM events FOR UPDATE",
        "WITH changed AS (UPDATE events SET id = 2 RETURNING *) SELECT * FROM changed",
        "SELECT pg_read_file('/etc/passwd')",
        "SELECT pg_sleep(10)",
        "SELECT public.lower('text')",
        "SELECT nextval('my_sequence')",
        "SELECT 'value'::public.custom_type",
        "SELECT 1 OPERATOR(public.=) 1",
        "SELECT 1 <=> 2",
        "EXPLAIN ANALYZE SELECT * FROM events",
        "SELECT (",
        "-- empty statement",
    ],
)
def test_rejects_unsafe_or_invalid_queries(statement: str) -> None:
    with pytest.raises(QueryError) as error:
        validate_query(statement)
    assert error.value.status == 400
