"""OpenTelemetry setup. Call init_tracing(service_name) once per process,
before any httpx/Celery/Redis calls happen, so the auto-instrumentation
patches are in place from the start.
"""
import logging

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.celery import CeleryInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.instrumentation.redis import RedisInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from second_brain.core.config import settings

logger = logging.getLogger(__name__)

_initialized = False


def init_tracing(service_name: str) -> None:
    """Sets up the global TracerProvider and instruments httpx/Celery/Redis.

    No-op if OTEL_ENABLED is false, or if already called in this process.
    """
    global _initialized
    if _initialized or not settings.OTEL_ENABLED:
        return
    _initialized = True

    provider = TracerProvider(resource=Resource.create({"service.name": service_name}))
    exporter = OTLPSpanExporter(endpoint=settings.OTEL_EXPORTER_OTLP_ENDPOINT, insecure=True)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    HTTPXClientInstrumentor().instrument()
    CeleryInstrumentor().instrument()  # type: ignore[no-untyped-call]
    RedisInstrumentor().instrument()

    logger.info(
        "OpenTelemetry tracing initialized (service=%s, endpoint=%s)",
        service_name,
        settings.OTEL_EXPORTER_OTLP_ENDPOINT,
    )


def get_tracer(name: str) -> trace.Tracer:
    return trace.get_tracer(name)
