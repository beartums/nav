"""promql.py: the VictoriaMetrics reply edge cases, without a VictoriaMetrics."""
import unittest

from promql import fill, label_summary, level, worst_level, number, points, result, series_name, single, step_for


def reply(kind, rows):
    return {"status": "success", "data": {"resultType": kind, "result": rows}}


class Values(unittest.TestCase):
    def test_samples_are_strings_and_may_be_nan_or_inf(self):
        self.assertEqual(number("42.5"), 42.5)
        self.assertIsNone(number("NaN"))
        self.assertIsNone(number("+Inf"))
        self.assertIsNone(number(None))

    def test_points_keep_gaps(self):
        self.assertEqual(points([[1, "1"], [2, "NaN"]]), [[1.0, 1.0], [2.0, None]])

    def test_step_never_finer_than_the_scrape(self):
        self.assertEqual(step_for(3600, 120), 30)
        self.assertEqual(step_for(600, 120), 15)


class Replies(unittest.TestCase):
    def test_error_reply_says_why(self):
        with self.assertRaisesRegex(ValueError, "parse error"):
            result({"status": "error", "error": "parse error at char 3"}, "vector")

    def test_wrong_result_type_is_named(self):
        with self.assertRaisesRegex(ValueError, "expected a matrix"):
            result(reply("vector", []), "matrix")

    def test_stat_refuses_many_series_with_advice(self):
        rows = [{"metric": {}, "value": [1, "1"]}] * 3
        with self.assertRaisesRegex(ValueError, "aggregate"):
            single(rows, "up")
        self.assertIsNone(single([], "up"))


class Names(unittest.TestCase):
    def test_default_drops_name_and_sorts(self):
        m = {"__name__": "up", "job": "node", "instance": "wk1"}
        self.assertEqual(series_name(m), "wk1, node")

    def test_legend_picks_labels(self):
        self.assertEqual(series_name({"instance": "wk1", "job": "node"}, "job"), "node")

    def test_falls_back_to_metric_name(self):
        self.assertEqual(series_name({"__name__": "up"}), "up")


class Templates(unittest.TestCase):
    def test_fill_and_missing_labels(self):
        m = {"instance": "wk1", "job": "node"}
        self.assertEqual(fill("{{instance}} ({{ job }})", m), "wk1 (node)")
        self.assertEqual(fill("{{nope}} \u00b0C", m), "\u00b0C")
        self.assertEqual(fill("/s", m), "/s")

    def test_legend_template_beats_the_comma_form(self):
        m = {"instance": "wk1", "job": "node"}
        self.assertEqual(series_name(m, "{{job}}/{{instance}}"), "node/wk1")
        self.assertEqual(series_name(m, "job"), "node")

    def test_label_summary(self):
        rows = [{"metric": {"__name__": "up", "instance": f"wk{i}", "job": "node"}} for i in range(12)]
        got = label_summary(rows, cap=3)
        self.assertEqual(sorted(got), ["instance", "job"])
        self.assertEqual(got["instance"]["count"], 12)
        self.assertEqual(len(got["instance"]["values"]), 3)
        self.assertEqual(got["job"], {"values": ["node"], "count": 1})


class WorstLevel(unittest.TestCase):
    def test_latest_value_of_the_worst_line(self):
        a = [[1, 95.0], [2, 50.0]]          # was critical, is fine NOW
        b = [[1, 10.0], [2, 85.0], [3, None]]   # latest real value 85: warn
        self.assertEqual(worst_level([a, b], 80, 90), "warn")
        self.assertEqual(worst_level([a], 80, 90), "ok")
        self.assertIsNone(worst_level([a, b], None, None))
        self.assertIsNone(worst_level([[[1, None]]], 80, 90))


class Levels(unittest.TestCase):
    def test_no_thresholds_means_no_status(self):
        self.assertIsNone(level(99, None, None))

    def test_higher_is_bad(self):
        self.assertEqual(level(50, 80, 90), "ok")
        self.assertEqual(level(85, 80, 90), "warn")
        self.assertEqual(level(95, 80, 90), "crit")

    def test_higher_is_good(self):
        # UPS charge: low is the problem.
        self.assertEqual(level(15, 50, 20, "good"), "crit")
        self.assertEqual(level(40, 50, 20, "good"), "warn")
        self.assertEqual(level(90, 50, 20, "good"), "ok")


if __name__ == "__main__":
    unittest.main()
