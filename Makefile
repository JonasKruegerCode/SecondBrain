# SecondBrain Dev Makefile
# One interpreter executable path; command prefixes belong in a wrapper script.
PYTHON ?= python3

# Opt-in managed wiki; does not stop or touch production containers/volumes.
.PHONY: demo demo-scale acceptance acceptance-scale acceptance-first-start acceptance-import acceptance-openrouter acceptance-stack
demo:
	PYTHONPATH=backend/src "$(PYTHON)" scripts/run-wiki-demo.py

# Fresh synthetic 320-page vault for the opt-in real-service scale browser check.
demo-scale:
	PYTHONPATH=backend/src "$(PYTHON)" scripts/run-wiki-demo.py --scale-pages 320

acceptance-scale:
	PYTHONPATH=backend/src "$(PYTHON)" scripts/run-wiki-acceptance.py --scale

# Fresh real API + Vite + normal Playwright suite. Never uses a personal vault.
acceptance:
	PYTHONPATH=backend/src "$(PYTHON)" scripts/run-wiki-acceptance.py

# Empty wiki, first real pages, then actual API/Vite restart on the same vault.
acceptance-first-start:
	PYTHONPATH=backend/src "$(PYTHON)" scripts/run-wiki-acceptance.py --first-start

# Owned local Git sources, exact import/retry checks and real browser restart.
acceptance-import:
	PYTHONPATH=backend/src "$(PYTHON)" scripts/run-wiki-import-acceptance.py

# Explicit paid-provider gate. Sends only the public fictional demo fixture.
acceptance-openrouter:
	PYTHONPATH=backend/src "$(PYTHON)" scripts/run-wiki-openrouter-acceptance.py --confirm-paid-provider

# Real isolated Compose build/start/restart/restore; local Docker required.
acceptance-stack:
	"$(PYTHON)" scripts/run-wiki-stack-acceptance.py

# Optional native development; never stop another installation to free ports.
# Prerequisites: backend Poetry env, frontend npm dependencies and explicit dev vault.
dev:
	cd backend && poetry run honcho start --procfile ../Procfile

dev-backend:
	cd backend && poetry run honcho start api mcp --procfile ../Procfile

# Run all checks: backend lint + types + tests + frontend types + build
check:
	cd backend && poetry run ruff check src/ tests/
	cd backend && poetry run mypy src/ tests/
	cd backend && poetry run pytest tests/ --ignore=tests/integration -q
	cd frontend && npm run typecheck
	cd frontend && npm run build

# Individual targets
lint:
	cd backend && poetry run ruff check src/ tests/

typecheck:
	cd backend && poetry run mypy src/ tests/

test:
	cd backend && poetry run pytest tests/ --ignore=tests/integration -q
