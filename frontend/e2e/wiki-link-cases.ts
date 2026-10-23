// New bounded synthetic corpus, not a reconstruction of the historical 336 cases.
// Placeholders are replaced with real pages by the browser/API parity probe.
export const wikiLinkCases = [
  { id: "plain", body: "Read [[T|Notebook]].", labels: ["Notebook"] },
  { id: "trimmed-alias", body: "Read [[ T |Notebook]].", labels: ["Notebook"] },
  { id: "repeated", body: "[[T|First]] and [[T|Second]]", labels: ["First", "Second"] },
  { id: "strong", body: "**Read [[T|Notebook]] carefully.**", labels: ["Notebook"] },
  { id: "quote", body: "> Read [[T|Notebook]].", labels: ["Notebook"] },
  { id: "task-list", body: "- [x] Read [[T|Notebook]].", labels: ["Notebook"] },
  { id: "inline-code", body: "`[[H]]` [[T|Notebook]]", labels: ["Notebook"] },
  { id: "multiline-code", body: "`open\n[[H]]\nclose` [[T|Notebook]]", labels: ["Notebook"] },
  { id: "paragraph-code-boundary", body: "`open\n\n[[T|Notebook]]\n\n`close", labels: ["Notebook"] },
  { id: "fence", body: "```md\n[[H]]\n```\n\n[[T|Notebook]]", labels: ["Notebook"] },
  { id: "quoted-fence", body: "> ```md\n> [[H]]\n> ```\n\n[[T|Notebook]]", labels: ["Notebook"] },
  // A comment at the start of a block consumes its same-line Markdown tail.
  { id: "block-comment", body: "<!-- [[H]] --> [[T|Notebook]]", labels: [] },
  { id: "inline-comment", body: "Note <!-- [[H]] --> [[T|Notebook]]", labels: ["Notebook"] },
  { id: "escaped-opener", body: "\\[[H]] [[T|Notebook]]", labels: ["Notebook"] },
  { id: "table-cell-boundary", body: "| one | two |\n| --- | --- |\n| `open | [[T]]` |", labels: ["Target ID"] },
  { id: "url", body: "HTTPS://example.invalid/[[H]] [[T|Notebook]]", labels: ["Notebook"] },
  { id: "emphasized-url", body: "*HTTPS://example.invalid/[[H]] **Field note!*** [[T|Notebook]]", labels: ["Notebook"] },
  { id: "reference-metadata", body: "[ref]: https://example.invalid/[[H]]\n\n[External][ref] [[T|Notebook]]", labels: ["Notebook"] },
  { id: "inline-destination", body: "[External](https://example.invalid/[[H]]) [[T|Notebook]]", labels: ["Notebook"] },
  { id: "span-attribute", body: 'Note <span title="[[H]]" onclick="window.__parityXss=1">[[T|Notebook]]</span>', labels: ["Notebook"] },
  { id: "kbd", body: "Note <kbd>[[T|Notebook]]</kbd>", labels: ["Notebook"] },
  { id: "mark", body: 'Note <mark style="color:red" onclick="window.__parityXss=2">[[T|Notebook]]</mark>', labels: ["Notebook"] },
  { id: "small", body: 'Note <small title="discarded" onmouseover="window.__parityXss=3">[[T|Notebook]]</small>', labels: ["Notebook"] },
] as const;
