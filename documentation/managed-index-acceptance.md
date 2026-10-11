# Disposable managed index acceptance

The managed index integration gate runs the managed Neo4j and Qdrant adapters
against real disposable servers started by Testcontainers. It uses only
deterministic synthetic pages and an injected synthetic embedder. It does not
load a production embedding model, call hosted model endpoints, or require
external model credentials. Git snapshots remain the content authority.

## Run locally

Use Python 3.12, Poetry 2.1.3, and a running Docker Engine. From the repository
root:

```sh
cd backend
poetry sync --no-interaction
mkdir -p ../.demo
SECOND_BRAIN_RUN_INDEX_INTEGRATION=1 poetry run pytest tests/integration/test_managed_indexes.py -v --junitxml=../.demo/managed-indexes.xml
```

The explicit opt-in flag is required for this integration module. Without it,
the module is skipped; a skipped run is not acceptance evidence. Testcontainers
uses the existing `neo4j_container` (`neo4j:5`) and `qdrant_container`
(`qdrant/qdrant:latest`) fixtures and cleans up their disposable containers.
These image tags can change independently of the locked Python dependencies;
the JUnit suite records their actual image IDs and repository digests. Inspect
those identities when comparing runs. Do not point this gate
at a private vault or production services.

## Evidence and CI

The [managed index workflow](../.github/workflows/managed-indexes.yml) runs on
pull requests targeting `main` and supports `workflow_dispatch`. It uses Ubuntu
with Docker, Python 3.12, Poetry 2.1.3, and the checked-in backend lockfile. Its
repository permission is read-only and its job timeout is 20 minutes. It does
not publish container images or reference repository secrets.

On success or failure, the workflow attempts to upload only
`.demo/managed-indexes.xml`, with seven-day retention. The JUnit report may
include assertions and diagnostic output from the synthetic tests. Vault
contents, environment files and container dumps are excluded. A failure before
pytest starts can leave no report; check the job outcome as well as the artifact.

Adding the workflow and tests does not establish that the gate passed. Inspect
the actual run for the reviewed revision and require executed, passing tests.
A missing, cancelled, failed, or entirely skipped run supplies no passing
acceptance evidence.

## Scope of the gate

Full snapshots isolate graph nodes, edges and vector collections by generation.
The gate is intended to check live-server writes and reads, exact page and
snapshot revisions, and graph traversal without crossing generation boundaries.
After a content change, retained old generations must not serve as current:
the coordinator requires a ready receipt matching both the current Git revision
and configuration before semantic or graph reads can succeed. Rebuilding must
restore current results, with deleted content excluded from the fresh snapshot.

Restart persistence checks restart both actual Docker containers, wait for
server readiness, and reconnect application clients and a durable coordinator
against the same vault. They require provider generations to remain usable and
ready receipts to remain unchanged. The gate also checks identical shared REST
and MCP semantic results, staleness after page deletion and recreation, and loss
of the actual vector collection: semantic reads must return `index_unavailable`
while graph and exact page reads remain available. An explicit rebuild must
recover vector results without changing the authoritative snapshot. These checks
do not establish persistence after container replacement, host loss, or a
production volume failure.

A separate graph-loss case deletes the ready Neo4j generation. Neighbor reads
must return `index_unavailable`, not a misleading empty neighborhood, while
semantic and exact reads remain usable. An explicit rebuild restores traversal.

The larger case imports the public 320-page, 648-link scale fixture, builds both
real provider generations and compares two-hop traversal with the authoritative
Markdown graph. It also checks bounded vector hits and GraphRAG revision
agreement. This is a bounded data-path check, not production load testing or a
semantic-quality benchmark; the injected vectors are intentionally synthetic.

Retention checks are intended to exercise dry-run planning and explicit deletion
against real providers while preserving the current ready generation, retained
ready generations, and untracked targets. Cleanup remains operator initiated;
it does not run automatically during normal startup or delivery. The integration
test assertions define the exact cases covered by a given revision.

A passing synthetic run establishes the exercised adapter/coordinator boundaries
on those server images. It does not validate production embedding quality,
hosted endpoints, production credentials and privileges, deployment persistence,
or provider-scale performance. See [managed indexes](managed-indexes.md) for
configuration, recovery and retention operations.
