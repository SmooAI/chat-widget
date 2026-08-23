---
'@smooai/chat-widget': patch
---

Run the Playwright e2e suite in CI, and add a real streaming guarantee (feature gap G5).

The e2e specs existed but **no CI job ever invoked them** — `ci.yml` ran typecheck/unit/build only, so the suite was reported coverage that had never executed. Two of its specs were in fact red.

- `ci.yml` gains an `E2E (credential-free)` job that builds the bundle and runs the hermetic specs on every PR.
- New `e2e-live.yml` (nightly) builds a lean in-memory `smooth-operator-server` and runs the credentialed, knowledge-grounded specs. A missing `SMOOAI_GATEWAY_KEY` **fails** the job rather than skipping silently.
- New `e2e/streaming.spec.ts` asserts assistant tokens render *incrementally*, before `eventual_response` arrives. The previous spec asserted only the final text, so a widget that dropped streaming entirely still passed it.
- Fixed `repro-stream-mock.spec.ts`, which made a real request to production (`/internal/resume-by-fingerprint` → 403) and failed on the resulting page error; it is now hermetic.
- `SMOOTH_AGENT_SERVER_BIN` overrides the hardcoded local server path so the live specs can run on a CI runner.
