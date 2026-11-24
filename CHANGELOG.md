# Changelog

## 1.0.0

First release.

- Warns when HEAD moves (branch switch, pull, rebase) and `node_modules` no longer matches `package-lock.json`, with a button to run `npm install` in each affected directory.
- Compares what is actually installed, so switching to a branch and back without installing gives no warning.
- Supports npm workspaces, `npm-shrinkwrap.json`, and projects without a lockfile (presence and exact-version checks).
- Ignores optional/platform-specific packages, `--omit=dev` installs, and yarn/pnpm/bun projects.
- **Check Whether npm install Is Needed** command and `staleNodeModules.installCommand` setting.
