# Guided 2.0 follow-up review

Use `secondbrain-2.0-next`, [Draft PR #20](https://github.com/JonasKruegerCode/SecondBrain/pull/20),
and the fictional Lantern Bay atlas. This is a functional review of the current
light interface. Large visual/animation changes belong to a later version.
No production vault, service, credentials or branch is changed by this tour.

## Prepare and identify the tested version

Fetch and fast-forward the review branch in a clean checkout; preserve unrelated
local work rather than resetting it. Record `git rev-parse HEAD` before starting.
The completed full CI baseline is `107a6b51eaa73de4396abc911eb5f6a8bc04d8c0`;
use the PR checks for any later commit rather than treating this as its signoff.

Follow [Run locally](demo-start.md#run-locally):

```bash
(cd backend && poetry sync --no-interaction)
(cd frontend && npm ci)
WIKI_PYTHON="$(cd backend && poetry env info --executable)"
SECOND_BRAIN_WIKI_API_KEY= make demo PYTHON="$WIKI_PYTHON"
```

Open <http://127.0.0.1:5173>. Use an isolated browser profile to avoid an old start
page or previous conversations affecting the tour. This launcher retains later
synthetic edits; do not reseed or delete a nonempty vault to restart it. Ctrl+C
stops both owned services. Run the same command again to check persistence.

The normal launcher intentionally has no model access. For real answers use the
explicit [OpenRouter opt-in](demo-start.md#take-a-short-tour), using an existing
local environment without printing, sharing or committing its values. A missing
key is a visible unavailable-provider test, not a real-model acceptance result.

## Review one action at a time (15–20 minutes)

After each row, collect feedback and one short clarification if needed. Park
implementation details and later visual ideas. Do not change code during the tour.

| Time | Action | Inspect together |
| --- | --- | --- |
| 0–3 min | Open Home, follow Mira Quill, then the archive-method link; use Back. | Natural navigation, readable article width and restored reading position. |
| 3–6 min | Search for `Mira Quill`, open the article and History. | Useful exact-match order; page revision versus the Git snapshot/commit. Semantic ranking and lexical lookup have different contracts. |
| 6–9 min | Edit one synthetic paragraph, save, reload and inspect History. | Revision-protected save, retained content and honest index/Git delivery state. A published local save is distinct from remote acknowledgement. |
| 9–12 min | Open Galaxy, select a group, inspect a member and its link evidence, then open the article. | Shared server group membership, explicit links and useful article return path. A cluster does not establish a factual dependency. |
| 12–15 min | With an enabled provider, ask the tide-clock warning question from the detailed demo, then compare it with the salt-marsh pilot. | Actual read sources, sensible multi-turn answers, readable Markdown and bounded failures. Without a provider, inspect retry and deletion only and leave model quality open. |
| 15–17 min | Try a narrow view, keyboard navigation, Enter/Shift+Enter and local conversation deletion. | Touch/keyboard reachability, message handling and persisted deletion. Emulation is not device installation. |
| 17–20 min | Review the actual-phone PWA outcome and the parked findings, then agree on the next step. | Separate must-fix items before merge, operator/device checks, and later visual work. No merge/deployment is performed during this procedure. |

For a conflict, keep the draft and reconcile against a fresh revision; never
resolve it by discarding an unseen change. The automated two-tab regression
covers conflict/recreation behavior beyond this short tour.

## Evidence and remaining gates

- [Review handoff](review-handoff.md) links the completed CI baseline. Navigation,
  chunking, reuse, chat and group evidence are in `documentation/evidence/`.
- The small atlas is for human clarity. The separately tested 818-page fixture
  establishes synthetic cache/model-call behavior, not production latency or load.
- Real OpenRouter quality needs actual answers and source inspection; scripted
  providers and an existing key alone cannot establish it.
- Test Android installation on the actual HTTPS/auth path. A successful manifest
  fetch, desktop prompt or emulated viewport does not prove mobile installation.
  Retest after the approved version is actually available on the test deployment;
  capture the exact browser error if installation still fails. Preserve auth.
- The local demo does not migrate a private vault, verify off-host restore or
  authorize production changes. Existing deployments remain untouched.

Record the inspected commit, browser/viewport, provider mode, device result and
agreed blockers compactly in the private canonical project status. A prepared
walkthrough is not a claim that every production/device gate has passed.
