# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets).
Add a changeset for every user-facing change:

```bash
pnpm changeset
```

On merge to `main`, the Release workflow opens a "🦋 New version release" PR that
bumps the version and updates the changelog; merging it publishes to npm.
