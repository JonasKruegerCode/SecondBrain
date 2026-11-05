# Local development

Use the [current development guide](managed-wiki-development.md). The root
Compose is the image-only installation; docker-compose.source.yml is its source
build overlay. Neither needs native host Python/Poetry/Node.

For native development only, install locked backend/frontend dependencies, choose
a dedicated vault with SECOND_BRAIN_WIKI_VAULT, and run `make dev`. The Procfile
starts the same current REST/MCP factories and Vite. No production containers are
stopped automatically. Select unused local ports instead of interrupting another
installation. Celery/Redis/Jaeger and the old application are no longer used.
