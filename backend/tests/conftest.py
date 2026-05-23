from typing import Any

import pytest
from testcontainers.core.container import DockerContainer
from testcontainers.core.wait_strategies import LogMessageWaitStrategy
from testcontainers.neo4j import Neo4jContainer
from testcontainers.redis import RedisContainer

from second_brain.core.celery_app import celery_app
from second_brain.core.config import settings


@pytest.fixture(scope="session")
def redis_container() -> Any:
    with RedisContainer("redis:7-alpine") as redis:
        yield redis


@pytest.fixture(scope="session")
def neo4j_container() -> Any:
    with Neo4jContainer("neo4j:5") as neo4j:
        yield neo4j


@pytest.fixture(scope="session")
def qdrant_container() -> Any:
    with DockerContainer("qdrant/qdrant:latest").with_exposed_ports(6333) as qdrant:
        qdrant.waiting_for(LogMessageWaitStrategy("Qdrant HTTP listening on"))
        yield qdrant


@pytest.fixture
def integration_settings(
    redis_container: Any,
    neo4j_container: Any,
    qdrant_container: Any,
    tmp_path: Any,
) -> Any:
    """Settings-Fixture nur für Integration-Tests — explizit anfordern."""
    redis_url = (
        f"redis://{redis_container.get_container_host_ip()}"
        f":{redis_container.get_exposed_port(6379)}/0"
    )
    try:
        neo4j_uri = neo4j_container.get_connection_url()
    except Exception:
        host = neo4j_container.get_container_host_ip()
        port = neo4j_container.get_exposed_port(7687)
        neo4j_uri = f"bolt://{host}:{port}"

    try:
        qdrant_url = qdrant_container.get_url()
    except Exception:
        host = qdrant_container.get_container_host_ip()
        port = qdrant_container.get_exposed_port(6333)
        qdrant_url = f"http://{host}:{port}"

    vault_path = str(tmp_path / "vault")

    orig = {
        "REDIS_URL": settings.REDIS_URL,
        "NEO4J_URI": settings.NEO4J_URI,
        "QDRANT_URL": settings.QDRANT_URL,
        "VAULT_PATH": settings.VAULT_PATH,
    }

    settings.REDIS_URL = redis_url
    settings.NEO4J_URI = neo4j_uri
    settings.NEO4J_USER = "neo4j"
    settings.NEO4J_PASSWORD = "password"
    settings.QDRANT_URL = qdrant_url
    settings.VAULT_PATH = vault_path

    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True

    yield settings

    for k, v in orig.items():
        setattr(settings, k, v)
    celery_app.conf.task_always_eager = False
    celery_app.conf.task_eager_propagates = False
