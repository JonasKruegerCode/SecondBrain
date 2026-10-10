# Start the fictional wiki demo

The Lantern Bay field atlas is a standalone sample profile with twelve invented pages. It connects astronomy, coastal ecology, food traditions, and archival history through fictional projects and people. Every page identifies its content as fictional. It contains no user records, and does not require a remote Git repository, an LLM, or the legacy Neo4j/Qdrant services.

Use this profile to try the core editable wiki before attempting a migration of an existing vault. The legacy memory service remains separate; this procedure does not migrate or import its data.

## Run locally

From the repository root, prepare the Python backend environment according to the main setup instructions. The backend must be importable, for example by using the backend's Poetry environment or setting `PYTHONPATH=backend/src`. Then explicitly choose a **new empty directory**:

```bash
export PYTHONPATH="$PWD/backend/src"
python -m second_brain.wiki.demo --vault .demo/vault
SECOND_BRAIN_WIKI_VAULT="$PWD/.demo/vault" \
  python -m uvicorn second_brain.wiki.api:app_factory --factory \
  --host 127.0.0.1 --port 8000
```

In a second terminal, from the repository root:

```bash
cd frontend
npm install
npm run dev
```

Open the local Vite URL printed in that terminal. Keep the API terminal running. The frontend development profile connects to the local standalone wiki API.

The API uses an explicit factory and requires `SECOND_BRAIN_WIKI_VAULT`. Importing the module does not create a vault. The managed vault's authoritative Markdown lives in local Git commit snapshots in `.wiki.git`, a bare repository inside the selected directory. It is not a folder of loose Markdown files to edit manually. Use the wiki editor or the normal save API so revisions, links, and search reflect the same saved content.

## Take a short tour

1. Open **Lantern Bay field atlas** and follow the night-sky route.
2. Search for `tide` and inspect how it connects astronomy, ecology, and history.
3. Follow the tide clock, archive method, harvest calendar, and festival links to see the bridges between subjects. Open `/galaxy` to compare the four curated constellations and inspect the actual Markdown links that cross between them.
4. Edit a page, save, and reload it. The saved Markdown remains available from the same local vault.
5. Keep two tabs open on the same page to try revision conflict handling.

## Seeding rules

For the explicit empty/template/local-Git first-start choice, see
[first-start.md](first-start.md). No first-start command replaces a populated wiki.

Nothing is seeded on API startup. The CLI requires `--vault`; there is no default destination. It writes pages through the same managed `WikiStore.save_page` path as ordinary edits.

- A nonempty directory without a valid completed demo marker is refused without changing its files.
- Repeating the command for a completed, unchanged demo verifies every page's ID and exact Markdown against the template, then reports `unchanged` without writing a new revision.
- A changed page, missing page, added page, or changed template causes a refusal. Your edits are preserved. Choose another empty directory for a fresh demo.
- An interrupted seed retains a marker with state `seeding`. An ordinary retry is refused. To recover explicitly, run the same command with `--resume`. The CLI verifies the template fingerprint and every existing page, then creates only missing pages through the normal save path. Any edited or unexpected page causes refusal. A local file lock serializes concurrent seeders; operating-system lock release permits recovery after a process stops.
- The `.second-brain-demo.json` marker is seeder metadata. Do not copy a completed marker into another vault or change its state to force a retry.

An optional `--template PATH` selects a flat directory of Markdown files instead of the checked-in `examples/demo-vault` template. Each filename becomes a page ID, and each page must begin with a level-one title. Template pages and the target vault must not be symbolic links. Use only clearly synthetic material for a public demo.

The template's examples are cultural and narrative material. They are not real observing forecasts, navigation instructions, harvesting advice, or food safety guidance.
