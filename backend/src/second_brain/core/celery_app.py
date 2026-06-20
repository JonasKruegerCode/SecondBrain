from celery import Celery
from celery.schedules import crontab

from second_brain.core.config import settings
from second_brain.core.telemetry import init_tracing

init_tracing("secondbrain-worker")

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
        "wiki-review-hourly": {
            "task": "second_brain.worker.tasks.wiki_review_hourly",
            "schedule": crontab(minute=0),
        },
    },
)

# Autodiscover tasks
celery_app.autodiscover_tasks(["second_brain.worker"])
