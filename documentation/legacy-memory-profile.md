# Legacy ingestion-memory compatibility profile

The repository retains its original agentic memory service for existing
installations. It is a **separate optional compatibility profile**, not the
primary SecondBrain 2.0 MCP offering.

The legacy profile exposes `remember`, `recall`, semantic/graph retrieval and
manual page operations through `second_brain.mcp_server`. Its ingestion and
repair paths depend on an LLM provider, Redis/Celery, Neo4j, Qdrant and a
filesystem Git vault. The original `docker-compose.yml`, `.env.example`,
`Procfile` and [legacy development guide](local_developement.md) remain for
operators who deliberately need that stack.

The managed profile instead exposes direct, revision-aware wiki tools from
`second_brain.wiki.mcp`. It has no `remember`, `recall`, editorial agent or
repair schedule. Core reads and edits require no model or external database.
Use the main [README](../README.md) and [managed MCP guide](managed-mcp.md) for
new installations and migration work.

## Isolation rule

Never point legacy and managed writers at the same vault. Their persistence and
mutation contracts differ:

- legacy writes loose Markdown through the ingestion/repair pipeline and its Git sync;
- managed writes immutable Git snapshots through revision and request-ID checks;
- provider index state and worker progress are not interchangeable.

Migrate through an explicit clean local Git import into a new managed vault.
Keep the original deployment and vault available for rollback until content,
IDs, links and operational recovery have been accepted. Do not reuse a legacy
Neo4j/Qdrant index as proof that it matches a managed content revision.

## Existing legacy startup

For an unchanged compatibility deployment:

```sh
cp .env.example .env
# Set provider, infrastructure, MCP and vault values deliberately.
docker compose up -d
```

This starts the original multi-service stack and legacy UI. Its HTTP MCP remains
on the legacy port and retains the old authentication/configuration contract.
Do not combine this command with `docker-compose.wiki.yml` against one volume.

## Deprecation boundary

No removal date is set. Before removing legacy endpoints, inventory real clients
and complete a controlled migration with rollback evidence. New documentation,
demos and agent integrations should use the managed profile unless they are
explicitly testing backward compatibility.
