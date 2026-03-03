# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Use Context7 MCP server for up-to-date library documentation.**

## Project Overview

@smooai/chat-widget is an embeddable AI chat widget component built with React/Preact for real-time AI conversations. It provides a drop-in chat interface that connects to the Smoo AI platform, featuring real-time messaging, customizable themes, and a compact bundle optimized for embedding in third-party websites.

---

## 1. Git Workflow -- Worktrees & Branches

### Working directory structure

All work happens from `~/dev/smooai/`. The main worktree is at `~/dev/smooai/chat-widget/`. Feature worktrees live alongside it:

```
~/dev/smooai/
├── chat-widget/                                # Main worktree (ALWAYS on main, kept up to date)
├── chat-widget-SMOODEV-XX-short-desc/          # Feature worktree
└── ...
```

**IMPORTANT:** `~/dev/smooai/chat-widget/` must ALWAYS stay on the `main` branch and be kept up to date. **Never do feature work directly on main.** All feature work goes in worktrees. After merging a feature branch, always `git pull --rebase` in the main worktree to keep it current.

### Branch naming

Always prefix with the Jira ticket number:

```
SMOODEV-XX-short-description
```

### Commit messages

Always prefix with the Jira ticket. Explain **why**, not just what:

```
SMOODEV-XX: Add typing indicator animation for better UX feedback
```

### Worktree workflow (default for all work)

#### Creating a worktree

```bash
# From the main worktree (~/dev/smooai/chat-widget)
git worktree add ../chat-widget-SMOODEV-XX-short-desc -b SMOODEV-XX-short-desc main

# Prep the worktree
cd ../chat-widget-SMOODEV-XX-short-desc
pnpm install
```

#### Merging to main

```bash
cd ~/dev/smooai/chat-widget
git checkout main && git pull --rebase
git merge SMOODEV-XX-short-desc --no-ff
git push
```

#### Cleanup after merge

```bash
git worktree remove ~/dev/smooai/chat-widget-SMOODEV-XX-short-desc
git branch -d SMOODEV-XX-short-desc
```

---

## 2. Project Structure

The project has a dual build system: a component library (bundled via tsup) and a test application (built via Vite).

```
src/
├── components/       # UI components (chat window, message bubbles, input, etc.)
├── library/          # Bundled library entry point for embedding
├── test-app/         # Demo/test application for local development
├── hooks/            # React hooks (WebSocket, state management)
├── store/            # Zustand state stores
├── types/            # TypeScript type definitions
└── utils/            # Shared utility functions
```

### Key Technologies

- **UI**: Preact (production) / React (development), Tailwind CSS, Shadcn UI (Radix primitives)
- **State**: Zustand for global state management
- **Data Fetching**: React Query (TanStack Query)
- **Build**: tsup (library bundle) + Vite (test app)
- **Testing**: Vitest

---

## 3. Development Commands

```bash
pnpm build            # Build both library (tsup) and test app (vite)
pnpm dev              # Start test app dev server (Vite)
pnpm test             # Run tests (Vitest)
pnpm typecheck        # TypeScript type checking
pnpm lint             # Lint with oxlint
pnpm format           # Format with oxfmt
pnpm check-all        # Run all checks (typecheck, lint, format, test, build)
```

---

## 4. Coding Style & Conventions

- Components in PascalCase, hooks as `useCamelCase`
- Tailwind utility composition with `clsx`
- Keep packages and directories kebab-case
- TypeScript strict mode

---

## 5. Changesets & Versioning

Always add changesets when the package changes:

```bash
pnpm changeset        # Interactive changeset creation
```

- Changesets describe what changed and why for the changelog

---

## 6. Testing

- Vitest for unit tests, colocated as `*.test.ts` or `*.test.tsx`
- All applicable tests must pass before landing code
