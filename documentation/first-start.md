# Choose a first-start profile

The managed wiki has no automatic content seeding. Choose one explicit mode before
starting its API. These commands use the same revisioned store as the editor and
MCP, require only local Git, and need no model key or remote repository.
Use Linux or WSL for this milestone: managed worker/template locks use `fcntl`,
and atomic plain export requires Linux `renameat2`. Native Windows execution has
not been accepted; the intended container runtime is Linux.

From the repository root, use your prepared backend Python environment and a new
destination. Replace `python` below with that environment's executable.

```sh
export PYTHONPATH="$PWD/backend/src"

# An empty persistent wiki, with no fictional pages.
python -m second_brain.wiki.setup --vault .demo/empty --mode empty

# The explicitly fictional twelve-page Lantern Bay atlas.
python -m second_brain.wiki.setup --vault .demo/example --mode template

# A committed, clean, complete local Git clone; optionally scope its wiki folder.
python -m second_brain.wiki.setup --vault .demo/imported --mode import \
  --source /absolute/path/to/local-clone --prefix 1_knowledge/wiki \
  --request-id first-import
```

The import mode also accepts an empty Git repository. Omit `--prefix` when its
Markdown is at the root. The first-start import is create-only: it cannot replace
an already published wiki. Repeating the identical request returns its original
publication revision; `current_revision` separately shows any later content.
For deliberate later replacements, use the [guarded importer](wiki-import.md)
with a reviewed whole-wiki base revision.

Rehearse this path with `make acceptance-import PYTHON=backend/.venv/bin/python`
from the repository root after installing the locked dependencies and Playwright
Chromium. The isolated runner uses only synthetic local Git repositories: an
empty source and the public twelve-page atlas with original source history.
Three real browser phases check the empty start, imported navigation/search/
galaxy/history and persistence after a browser edit, identical setup retry and
API/frontend restart. Competing first-start/template requests must refuse the
populated destination without losing edits. Source files, source HEAD, all page
content/revisions, history and graph are compared. Successful runs remove the
owned sources, vaults and browser phase inputs; CI publishes only structural
results, browser logs and synthetic screenshots. Remote authentication, private
vault migration, real models and physical-device installation remain separate.

Start the chosen profile, for example:

```sh
SECOND_BRAIN_WIKI_VAULT="$PWD/.demo/example" \
  python -m uvicorn second_brain.wiki.api:app_factory --factory \
  --host 127.0.0.1 --port 8000
```

Run the frontend from a second terminal with `cd frontend && npm run dev` after
installing its dependencies. For the one-command isolated development tour, use
[`make demo`](managed-wiki-development.md). Setup itself neither starts a server
nor configures production services, remotes, or secrets.

For the isolated container preview, copy `.env.wiki.example` to the ignored
`.env.wiki`, set a real MCP secret, and run:

```sh
docker compose --env-file .env.wiki -f docker-compose.wiki.yml up -d --build
```

This starts with an empty persistent named volume unless a prepared managed
vault is restored into that volume by an explicit operator procedure. It never
auto-seeds template content. Verify the actual revision and runtime with the
disposable rehearsal below; success there does not accept a private-vault restore
or production proxy configuration.

For a disposable synthetic container rehearsal, use `make acceptance-stack`;
the [stack guide](managed-stack-acceptance.md) covers its separate project,
dynamic loopback ports, restart and independent-volume restore checks.

Repeating an empty setup checks that no pages exist. A populated wiki is refused.
Repeating a template setup verifies unchanged content; edits, extra pages and
missing pages are preserved and cause refusal. An interrupted template requires
an explicit `--resume` with the same template, which validates existing pages
before creating only missing ones. A custom synthetic template can be selected
with `--template PATH`. Source/prefix flags apply only to import; template/resume
flags apply only to template, so unrelated arguments are refused.

Raw Markdown folders require deliberate migration; they are not adopted silently.
Use the [verified backup/restore command](backup-restore.md) to preserve the
authoritative Git history, request receipts and known local metadata without
overwriting a live vault. [Optional index providers](managed-indexes.md) remain separate: initial
content is available even when they are disabled or pending. Chat, galaxy and PWA
are separate runtime capabilities rather than setup modes. The [PWA guide](pwa.md)
documents HTTPS, installation, privacy and updates; first-start itself does not
verify a physical-device installation.
