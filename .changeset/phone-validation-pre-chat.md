---
'@smooai/chat-widget': minor
---

Pre-chat phone field now formats and validates as you type (libphonenumber-js, US default region).

- **As-you-type formatting** via `AsYouType('US')` — appended digits are formatted live (e.g. `(213) 373-4253`). The formatter only rewrites when the caret is at the end and never while deleting, so backspacing the formatting characters works naturally.
- **Inline validity hint** driven by `isValidPhoneNumber(value, 'US')` — a subtle, themed valid/invalid state on the field plus a small hint span. An empty field stays neutral (the field is optional unless `requirePhone`).
- **On submit**: when `requirePhone` is set and the number is invalid, submission is blocked and the hint is shown; when optional, submission proceeds. A valid number is sent as canonical **E.164** (`parsePhoneNumber(value, 'US').number`), falling back to the raw value when it does not parse (the backend re-parses and normalizes/nulls authoritatively — SMOODEV-2153).
- Autofill is preserved: `type="tel"`, `autocomplete="tel"`, and the implicit `<label>` are unchanged, and the value is also reformatted/validated on `change` so a browser-autofilled number gets handled too.

The standalone IIFE bundle now inlines `libphonenumber-js/min` (added to `deps.alwaysBundle`) so a plain `<script>` embed has no undefined-global reference at load.
