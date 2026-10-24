import tempfile
import unittest
from pathlib import Path

from second_brain.wiki import store
from second_brain.wiki.bounded_script import project_flat_scripts


class ProjectionTests(unittest.TestCase):
    def test_known_inline_pairs(self):
        for tag in ("script", "ScRiPt", "SCRIPT"):
            source = (
                f"# Fictional\n\nBefore [[kept]] <{tag}>hidden [[removed]]</{tag}> after [[tail]]."
            )
            projected = project_flat_scripts(source)
            self.assertEqual(len(source), len(projected))
            self.assertEqual(source.count("\n"), projected.count("\n"))
            self.assertIn("[[kept]]", projected)
            self.assertIn("[[tail]]", projected)
            self.assertNotIn("removed", projected)
            self.assertEqual(project_flat_scripts(projected), projected)

    def test_unsupported_is_atomic(self):
        unsupported = [
            "`<script>[[kept]]</script>`",
            "```html\n<script>[[kept]]</script>\n```",
            "1.     Note <script>[[kept]]</script>",
            "12)     Note <script>[[kept]]</script>",
            "> Note <script>[[kept]]</script>",
            "- Note <script>[[kept]]</script>",
            "    Note <script>[[kept]]</script>",
            "Note <ſcript>[[kept]]</ſcript>",
            "Note <scrİpt>[[kept]]</scrİpt>",
            "Note <scrıpt>[[kept]]</scrıpt>",
            "Note \\<script>[[kept]]</script>",
            "Note <script><!-- [[kept]] --></script>",
            "Note <script>`</script>` [[kept]]</script>",
            "Note <script>\n[[kept]]\n</script>",
            "Note <script>&lt;/script&gt; [[kept]]</script>",
            'Note <script data-x="x>y">[[kept]]</script>',
            "<div>Note <script>[[kept]]</script></div>",
            "Note <script>[[kept]]</script >",
            "Note <script/>[[kept]]</script>",
            "Note <script>[[kept]]",
            "Note <style>[[kept]]</style>",
            "Note <textarea>[[kept]]</textarea>",
            "Note [[not allowed|non-ASCII ä]]",
            "Note <script>[[kept]]</script>\r\n",
        ]
        for fragment in unsupported:
            # A valid earlier island must not cause partial filtering.
            source = "Control <script>[[removed]]</script>\n\n" + fragment
            with self.subTest(fragment=fragment):
                self.assertEqual(source, project_flat_scripts(source))

    def test_multiple_spans_preserve_positions(self):
        source = "One <script>[[x]]</script> [[a]] <script>[[y]]</script> [[b]]"
        result = project_flat_scripts(source)
        for target in ("[[a]]", "[[b]]"):
            self.assertEqual(source.index(target), result.index(target))
        self.assertNotIn("[[x]]", result)
        self.assertNotIn("[[y]]", result)

    def test_actual_store_graph_excerpt_source_history_and_retry(self):
        source = (
            "# Fictional source\n\nNote [[kept]] "
            "<script>hiddenmarker [[removed]]</script> [[missing]]."
        )
        with tempfile.TemporaryDirectory() as tmp:
            wiki = store.WikiStore(Path(tmp))
            wiki.save_page("kept", "# Kept", None, "create-kept")
            wiki.save_page("removed", "# Removed", None, "create-removed")
            receipt = wiki.save_page("source", source, None, "create-source")
            page = wiki.get_page("source")
            self.assertEqual(page["markdown"], source)
            self.assertEqual(page["revision"], receipt["revision"])
            self.assertNotIn("hiddenmarker", page["excerpt"])
            graph = wiki.graph()
            self.assertEqual(
                [(e["source"], e["target"]) for e in graph["edges"]], [("source", "kept")]
            )
            self.assertEqual(graph["missing_targets"], [{"source": "source", "target": "missing"}])
            self.assertEqual(wiki.backlinks("removed")["total"], 0)
            self.assertEqual(wiki.backlinks("kept")["total"], 1)
            self.assertEqual(len(wiki.history("source")), 1)
            self.assertEqual(wiki.save_page("source", source, None, "create-source"), receipt)
            reopened = store.WikiStore(Path(tmp))
            self.assertEqual(reopened.get_page("source"), page)
            # Lexical source search remains deliberately unchanged.
            self.assertEqual(wiki.search("hiddenmarker")[0]["id"], "source")


if __name__ == "__main__":
    unittest.main()
