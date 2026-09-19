# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-18

### Changed

- Dev deps: vitest 5 with @vitest/coverage-v8 5 (coverage gate unchanged: 90/80).
- Trunk-based workflow: `main` is the only branch (PRs required, protected by rulesets); `dev` removed.

### Added

- Orchestrator: `mesh_spawn` runs tasks as tracked headless workers in isolated opencode worktrees (native worktree API), with `mesh_workers`, `mesh_worker_logs`, `mesh_worker_stop`, and `mesh_worker_remove`; plugin dispose SIGTERMs live workers.
- Coverage gate in CI: 90% lines/functions, 80% branches (`pnpm test:coverage` locally).
- Dependabot group coupling vitest with @vitest/* (coverage provider) so major bumps arrive together.
- CONTRIBUTING.md documents the mandatory test-first flow and the solo-maintainer merge preference.
- CONTRIBUTING.md documents the Dependabot dependency PR routine (criteria, maintainer approval, workflow-file merge options).
- Project scaffold: Apache-2.0 license, CI (biome + typecheck + vitest + gitleaks, Node 22/24 matrix), npm publish via trusted publishing, issue and PR templates, Dependabot, lefthook pre-commit.

### Fixed

- Runtime compatibility with the installed OpenCode binary: ephemeral-port fallback for mesh servers, in-process fetch reuse for the worktree API in `opencode run` mode, `bun:sqlite` module resolution for hot-loaded plugins, and workers defaulting to `--agent build`.
- CI gitleaks job no longer fails on Dependabot pull requests (push-only).
