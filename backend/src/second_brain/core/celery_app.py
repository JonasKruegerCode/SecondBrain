from typing import Any

from celery import Celery, signals
from celery.schedules import crontab

from second_brain.core.config import settings
from second_brain.core.telemetry import init_tracing


def _init_worker_tracing(**_kwargs: Any) -> None:
    init_tracing("secondbrain-worker")


def _init_beat_tracing(**_kwargs: Any) -> None:
    init_tracing("secondbrain-worker-beat")


signals.worker_process_init.connect(_init_worker_tracing)
signals.beat_init.connect(_init_beat_tracing)

celery_app = Celery(
    "second_brain_worker",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    beat_schedule={
        "git-sync-daily": {
            "task": "second_brain.worker.tasks.git_sync_daily",
            "schedule": crontab(hour=3, minute=0),
        },
        "vault-repair-hourly": {
            "task": "second_brain.worker.tasks.vault_repair_hourly",
            "schedule": crontab(minute=0),
        },
        # Keep idle instances live: pull + reindex remote changes every 5 min
        "vault-sync-5min": {
            "task": "second_brain.worker.tasks.reindex_after_pull",
            "schedule": 300.0,
        },
    },
)

# Autodiscover tasks
celery_app.autodiscover_tasks(["second_brain.worker"])
