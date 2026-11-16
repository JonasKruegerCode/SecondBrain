import type { Reporter, TestCase, TestResult, TestStep } from "@playwright/test/reporter";
import { performance } from "node:perf_hooks";

// Only structural timing for the real body-stall test. Never log request bodies,
// page contents, API credentials, or unrelated tests.
const title = "a stalled save body times out after successful headers and replays the real receipt";

export default class SaveBodyReporter implements Reporter {
  private starts = new Map<TestResult, number>();

  onTestBegin(test: TestCase, result: TestResult) {
    if (test.title !== title) return;
    this.starts.set(result, performance.now());
    this.log(result, { event: "test-begin", repeat: test.repeatEachIndex, timeout_ms: test.timeout });
  }

  onStepBegin(test: TestCase, result: TestResult, step: TestStep) {
    if (test.title === title && ["fixture", "hook", "test.step"].includes(step.category)) {
      this.log(result, { event: "step-begin", category: step.category, title: step.title });
    }
  }

  onStepEnd(test: TestCase, result: TestResult, step: TestStep) {
    if (test.title === title && ["fixture", "hook", "test.step"].includes(step.category)) {
      this.log(result, {
        event: "step-end", category: step.category, title: step.title,
        duration_ms: step.duration, failed: Boolean(step.error),
      });
    }
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (test.title !== title) return;
    this.log(result, { event: "test-end", status: result.status, duration_ms: result.duration });
    this.starts.delete(result);
  }

  private log(result: TestResult, details: Record<string, unknown>) {
    const start = this.starts.get(result);
    console.info("[save-body-runner] " + JSON.stringify({
      elapsed_ms: start === undefined ? null : Math.round(performance.now() - start), ...details,
    }));
  }
}
