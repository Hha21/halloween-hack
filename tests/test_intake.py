"""Intake tests: Python-side unit conversion and checks on Gemini's extraction (Owner: Harry).

No network: these feed canned extractions straight into `spec_from_extraction`.
"""

from __future__ import annotations

import os
import unittest
from dataclasses import fields

os.environ["SPIRAL_OFFLINE"] = "1"  # tests never call Gemini

from spiral.agent import parse_intake_description  # noqa: E402
from spiral.agent.gemini import DEFAULT_REASONS, spec_from_extraction  # noqa: E402
from spiral.contract import MissionSpec  # noqa: E402

DEMO = "Four-seat touring aircraft, 1,000 km range with 45 min reserve, cruise 115 kt, stall under 55 kt."


def stated(field: str, evidence: str, value: float | None = None, unit: str | None = None, choice: str | None = None) -> dict:
    item = {"field": field, "basis": "stated", "evidence": evidence}
    if choice is not None:
        item["choice"] = choice
    else:
        item.update(value=value, unit=unit)
    return item


class TestSpecFromExtraction(unittest.TestCase):
    def test_converts_units_and_marks_only_unstated_fields_as_defaulted(self) -> None:
        extraction = {
            "name": "Demo Tourer",
            "items": [
                stated("range", "1,000 km range", 1000, "km"),
                stated("reserve", "45 min reserve", 45, "min"),
                stated("cruise_speed", "cruise 115 kt", 115, "kt"),
                stated("stall_speed", "stall under 55 kt", 55, "kt"),
                stated("passenger_count", "Four-seat", 3, "-"),
            ],
            "warnings": [],
        }
        spec = spec_from_extraction(extraction, DEMO, source="test").value
        self.assertEqual(spec.name, "Demo Tourer")
        self.assertEqual(spec.range_m, 1_000_000.0)
        self.assertEqual(spec.reserve_s, 2700.0)
        self.assertAlmostEqual(spec.cruise_speed_ms, 59.16, places=2)
        self.assertAlmostEqual(spec.stall_speed_ms, 28.29, places=2)
        self.assertEqual(spec.passenger_count, 3)
        self.assertIsInstance(spec.passenger_count, int)

        stated_fields = {"range_m", "reserve_s", "cruise_speed_ms", "stall_speed_ms", "passenger_count"}
        self.assertTrue(stated_fields.isdisjoint(spec.defaulted_fields))
        expected_defaults = {f.name for f in fields(MissionSpec) if f.name in DEFAULT_REASONS} - stated_fields
        self.assertEqual(set(spec.defaulted_fields), expected_defaults)

    def test_rejects_out_of_range_and_wrong_units(self) -> None:
        description = "cruise 115 kt, range 300 km/h"
        extraction = {
            "name": "x",
            "items": [
                stated("cl_max", "cruise 115 kt", 115, "-"),  # number put in the wrong field
                stated("range", "300 km/h", 300, "km/h"),  # speed unit on a distance
            ],
            "warnings": [],
        }
        result = spec_from_extraction(extraction, description, source="test")
        self.assertEqual(result.value.cl_max, MissionSpec().cl_max)
        self.assertEqual(result.value.range_m, MissionSpec().range_m)
        self.assertIn("cl_max", result.value.defaulted_fields)
        self.assertEqual(len(result.warnings), 2)

    def test_misquoted_or_uncited_inferences_do_not_override_defaults(self) -> None:
        description = "Two-seat aerobatic trainer."
        extraction = {
            "name": "x",
            "items": [
                {"field": "ld_max", "basis": "inferred", "evidence": "Typical value.", "value": 10, "unit": "-"},
                stated("range", "500 km", 500, "km"),  # not in the description
                {"field": "limit_load_factor", "basis": "inferred", "evidence": "aerobatic", "value": 6, "unit": "g"},
            ],
            "warnings": [],
        }
        result = spec_from_extraction(extraction, description, source="test")
        spec = result.value
        self.assertEqual(spec.ld_max, MissionSpec().ld_max)
        self.assertEqual(spec.range_m, MissionSpec().range_m)
        self.assertEqual(spec.limit_load_factor, 6.0)
        self.assertTrue(spec.defaulted_fields["limit_load_factor"].startswith("Inferred by test"))
        self.assertTrue(any("aren't in the description" in w for w in result.warnings))


class TestOfflineParser(unittest.TestCase):
    def test_demo_description(self) -> None:
        result = parse_intake_description(DEMO)
        spec = result.value
        self.assertEqual(spec.range_m, 1_000_000.0)
        self.assertEqual(spec.reserve_s, 2700.0)
        self.assertAlmostEqual(spec.cruise_speed_ms, 59.16, places=2)
        self.assertAlmostEqual(spec.stall_speed_ms, 28.29, places=2)
        self.assertNotIn("passenger_count", spec.defaulted_fields)
        self.assertIn("offline parser", result.warnings[0])

    def test_metric_speeds_seats_and_wing(self) -> None:
        spec = parse_intake_description("A 6-seat low-wing tourer, 1500 km range cruising at 300 km/h").value
        self.assertEqual(spec.passenger_count, 5)
        self.assertEqual(spec.range_m, 1_500_000.0)
        self.assertAlmostEqual(spec.cruise_speed_ms, 83.33, places=2)
        self.assertEqual(spec.wing_position, "low")


if __name__ == "__main__":
    unittest.main()
