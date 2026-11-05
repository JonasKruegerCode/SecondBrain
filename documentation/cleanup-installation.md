# One application and one standard installation

The previous default Compose selected the old UI and old combined backend even
though the explicit wiki acceptance path used the new application. This change
makes the root image installation, backend default command, frontend build,
environment template and README select the same current Wiki-first application.

## Change boundary

- Root Compose is image-only: frontend, REST and MCP; no source/build paths or
  host startup scripts. The backend default is the native REST factory; MCP
  selects its native HTTP factory from the same backend image.
- A source-build overlay is explicit. Optional index databases are separate
  infrastructure services, not another application. The env template covers
  shared Git/auth/provider settings and loopback ports.
- Old UI and old app/ingestion/repair/Celery/Redis/LangGraph/telemetry code and
  exclusively required dependencies/tests are removed after import tracing.
  Current bounded provider diagnostics and meaningful privacy tests remain.
- Current Git/auth/Markdown/revision/history/editor/search/graph/vector/GraphRAG/
  chat/PWA paths remain. No new supervisor, migration script or production change.

This is a breaking removal of old application endpoints and image defaults.
Before merge, review all old `latest` consumers and retain their actual old
images/Compose configuration. The [operator notes](install-update.md#existing-installations-and-breaking-changes)
explain volume/path selection and the retained-image fallback. Do not apply the
new images to a Celery command or a legacy-HTML frontend command.

## Evidence and limits

Local frontend typechecks, production build and all fifteen Node tests passed.
The output contains only the current index entry; the obsolete second JS bundle
and its large-bundle warning are gone. Backend removal was checked through the
actual remaining import graph and lockfile, with retained dependency versions.
The complete remaining local backend suite passed: 1700 tests plus 46 subtests;
23 integration tests were deselected. Ruff and strict Mypy over 132 files passed.
After actually uninstalling all 50 removed packages, 65 current provider/auth/
Git/index/chat cases passed. No retained package versions changed.

A local real API/Vite start and health check succeeded, and the runner cleaned
up both services. The attempted browser slice could not launch: the locked
Chromium download was invalid, and an alternative Chrome executable was denied
its singleton socket by the workspace (EPERM). No successful browser navigation
or screenshot evidence is claimed for this cleanup run; the full hosted browser
gate remains required.

The inline smart-HTTP Git fixture was separately executed locally with actual
clone, push and external pull, then cleaned up. All 74 stack/update runner
guardrail cases and 16 Make recipe cases passed. These do not substitute for
the Docker run.

The stack CI gate now tests the standard image route in an empty directory,
including local registry transfer, automatic Git synchronization and restart,
then the existing comprehensive HTTPS/auth/proxy and recovery paths. Docker is
not available in the editing workspace: newly added Docker phases are **pending
actual hosted execution** until the PR's CI result confirms them. Do not interpret
runner unit tests as Docker evidence. Public registry artifacts are published
only after a separately approved merge; no candidate image publication or server
deployment has been performed by this cleanup.

Synthetic vector/provider/browser evidence does not establish actual model
quality, private data migration, existing production configuration or physical
Android installation. Those boundaries remain explicit and do not justify
retaining a second obsolete application.
