from pglast import ast, parse_sql
from pglast.enums import A_Expr_Kind
from pglast.parser import ParseError
from pglast.stream import RawStream

from datahub_query_service.errors import QueryError

SAFE_FUNCTIONS = frozenset(
    "abs avg count min max sum round ceil ceiling floor trunc mod power sqrt length char_length octet_length lower upper trim btrim ltrim rtrim substring substr replace concat concat_ws split_part left right position strpos starts_with date_trunc date_part extract age now current_date current_timestamp to_char to_date to_timestamp make_date make_timestamp timezone json_build_object jsonb_build_object json_agg jsonb_agg json_object_agg jsonb_object_agg json_array_length jsonb_array_length json_typeof jsonb_typeof to_json to_jsonb array_agg array_length cardinality unnest generate_series row_number rank dense_rank ntile lead lag first_value last_value nth_value percentile_cont percentile_disc stddev stddev_pop stddev_samp variance var_pop var_samp bool_and bool_or every string_agg regexp_replace regexp_match regexp_matches regexp_split_to_array regexp_split_to_table format encode decode md5".split()
)
SAFE_TYPES = frozenset(
    "bool boolean int2 int4 int8 smallint integer bigint numeric decimal float4 float8 real double precision text varchar bpchar char name date time timetz timestamp timestamptz interval json jsonb uuid bytea bit varbit".split()
)
SAFE_OPERATORS = frozenset(
    "= <> != < > <= >= + - * / % ^ || ~ ~* !~ !~* ~~ ~~* !~~ !~~* -> ->> #> #>> @> <@ ? ?| ?& && & | # << >> @-@ <-> ! !~".split()
)


def names(node: object) -> list[str]:
    return [str(item.sval) for item in node] if isinstance(node, (tuple, list)) else []


def validate_query(sql: str) -> str:
    try:
        statements = parse_sql(sql)
    except (ParseError, ValueError, RuntimeError, RecursionError):
        raise QueryError(400, "INVALID_SQL", "The SQL could not be parsed.") from None
    if len(statements) != 1 or not isinstance(statements[0].stmt, ast.SelectStmt):
        raise QueryError(
            400, "QUERY_NOT_READ_ONLY", "Submit a single read-only SELECT statement."
        )
    stack: list[object] = [statements[0].stmt]
    visited = 0
    while stack:
        node = stack.pop()
        visited += 1
        if visited > 10000:
            raise QueryError(400, "QUERY_TOO_COMPLEX", "The query is too complex.")
        if isinstance(node, (tuple, list)):
            stack.extend(node)
        elif isinstance(node, ast.Node):
            kind = type(node).__name__
            if kind.endswith("Stmt") and kind != "SelectStmt":
                raise QueryError(
                    400,
                    "QUERY_NOT_READ_ONLY",
                    "Write statements are not allowed, including inside a CTE.",
                )
            if isinstance(node, ast.SelectStmt) and (
                node.intoClause or node.lockingClause
            ):
                raise QueryError(
                    400,
                    "QUERY_NOT_READ_ONLY",
                    "SELECT INTO and locking clauses are not allowed.",
                )
            if isinstance(node, ast.FuncCall):
                function = names(node.funcname)
                if (
                    not function
                    or function[-1] not in SAFE_FUNCTIONS
                    or (len(function) > 1 and function[:-1] != ["pg_catalog"])
                ):
                    raise QueryError(
                        400,
                        "FUNCTION_NOT_ALLOWED",
                        "This function is not enabled for read-only queries.",
                    )
                # Schema precedence alone does not prevent an overload in a user schema
                # from being selected when its signature is a closer match.
                node.funcname = (
                    ast.String(sval="pg_catalog"),
                    ast.String(sval=function[-1]),
                )
            if isinstance(node, ast.TypeName):
                typename = names(node.names)
                if (
                    not typename
                    or typename[-1] not in SAFE_TYPES
                    or (len(typename) > 1 and typename[:-1] != ["pg_catalog"])
                ):
                    raise QueryError(
                        400,
                        "TYPE_NOT_ALLOWED",
                        "This cast is not enabled for read-only queries.",
                    )
                node.names = (
                    ast.String(sval="pg_catalog"),
                    ast.String(sval=typename[-1]),
                )
            if isinstance(node, ast.A_Expr):
                operator = names(node.name)
                if operator and (
                    operator[-1] not in SAFE_OPERATORS
                    or (len(operator) > 1 and operator[:-1] != ["pg_catalog"])
                ):
                    raise QueryError(
                        400,
                        "OPERATOR_NOT_ALLOWED",
                        "Custom operators are not enabled for read-only queries.",
                    )
                if operator and node.kind in (
                    A_Expr_Kind.AEXPR_OP,
                    A_Expr_Kind.AEXPR_OP_ANY,
                    A_Expr_Kind.AEXPR_OP_ALL,
                ):
                    node.name = (
                        ast.String(sval="pg_catalog"),
                        ast.String(sval=operator[-1]),
                    )
            stack.extend(getattr(node, field) for field in node)
    return str(RawStream()(statements[0].stmt))
