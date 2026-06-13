# Changelog

All notable changes to `@smooai/chat-widget` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0

The widget is back as a standalone package — and got a complete visual redesign.

### Added

- **"Aurora Glass" design system** — a full rebuild of the widget's visual layer:
    - Spring launcher with a live "presence pulse" breathing ring and a crafted
      chat-spark icon (no more emoji).
    - Glass-depth panel with layered ambient shadows, a brand-tinted top glow, and
      a spring entrance animation.
    - Header with a gradient brand avatar (agent monogram), a live connection
      status dot (green online / amber connecting / red error), and an icon close.
    - Message rows with assistant mini-avatars, a real animated **typing
      indicator**, message rise-in, and a refined streaming cursor.
    - Refined **Sources** disclosure with a count pill and accent cards.
    - Icon composer: a focus-lit field with a circular gradient send button,
      auto-growing textarea, and a "powered by smooth-operator" footer.
- **Derived theme tokens** — `primary-2` (gradient depth) and `surface-2` (inset
  wash) are computed in CSS from `primary`/`text`, so a single `primary` color
  themes the whole widget and adapts to light or dark automatically.
- Unit + render test suite (vitest + jsdom) covering config resolution, style
  injection, the XSS-safe citation URL guard, and the rendered shadow tree.
- GitHub Actions CI (typecheck · test · build) and a backend-free interactive
  showcase (`index.html`) driven by an in-page protocol mock.

### Changed

- Default `theme.border` is now a translucent value (`rgba(255,255,255,.1)`) for
  the glass aesthetic.
- Depends on `@smooai/smooth-operator@^0.2.0`.

### Notes

This release reverses the brief deprecation in which the widget shipped only as a
subpath of `@smooai/smooth-operator`. The widget is once again its own package,
consuming `@smooai/smooth-operator` purely for the protocol client — one source of
truth for the wire protocol, one dedicated home for the embeddable UI.
