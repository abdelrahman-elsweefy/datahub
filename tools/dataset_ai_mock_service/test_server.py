import unittest

from server import RequestValidationError, build_response, sample_sql_for_dataset, validate_request


DATASET_URN = "urn:li:dataset:(urn:li:dataPlatform:postgres,my_db.my_schema.events,PROD)"


class DatasetAiMockServiceTest(unittest.TestCase):
    def test_validates_context_and_builds_new_tab_response(self) -> None:
        request = validate_request(
            {
                "context": {"datasetUrn": DATASET_URN, "userUrn": "urn:li:corpuser:user1"},
                "question": "Show recent events",
                "conversationId": None,
                "target": {"mode": "NEW_TAB"},
            }
        )

        response = build_response(request, "request-1")

        self.assertEqual(response["requestId"], "request-1")
        self.assertEqual(response["sqlAction"]["type"], "CREATE_TAB")
        self.assertIn('FROM "my_schema"."events"', response["sqlAction"]["statement"])

    def test_preserves_pasted_sql_as_part_of_the_question(self) -> None:
        question = "Improve this query:\nSELECT * FROM my_schema.events"
        request = validate_request(
            {
                "context": {"datasetUrn": DATASET_URN, "userUrn": "urn:li:corpuser:user1"},
                "question": question,
                "target": {"mode": "NEW_TAB"},
            }
        )

        response = build_response(request, "request-2")

        self.assertEqual(request["question"], question)
        self.assertEqual(response["sqlAction"]["type"], "CREATE_TAB")

    def test_rejects_removed_modify_tab_mode(self) -> None:
        with self.assertRaises(RequestValidationError):
            validate_request(
                {
                    "context": {"datasetUrn": DATASET_URN, "userUrn": "urn:li:corpuser:user1"},
                    "question": "Modify a query",
                    "target": {"mode": "MODIFY_TAB"},
                }
            )

    def test_uses_safe_fallback_for_unusable_dataset_names(self) -> None:
        self.assertEqual(sample_sql_for_dataset("not-a-dataset-urn"), "SELECT 1 AS sample_value;")


if __name__ == "__main__":
    unittest.main()
