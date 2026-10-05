# Project Development Rules

## Project scope

This repository contains a local-first Node.js web application for AI-assisted paper reading.

## Directory and naming rules

- Application source code lives in `src/`, split by responsibility:
  - `src/server/`: HTTP server, API routes, persistence, paper import, model integrations.
  - `src/web/`: browser UI assets.
  - `src/shared/`: small shared types and pure helpers.
- Tests live in `tests/` and mirror the relevant source responsibility.
- Development and maintenance scripts live in `scripts/`.
- Local paper files, caches, logs, temporary jobs, and runtime state live under `.runtime/`.
- Use descriptive names that state the task or artifact; do not use numeric experiment IDs.
- Keep source, tests, configuration, and documentation in Git. Keep dependencies, generated builds, papers, model files, logs, and runtime state out of Git.

## Runtime artifact rules

- Use `.runtime/<task-name>/` for a running task's logs and temporary results.
- Reuse the same task directory when rerunning an unstarted or clearly self-caused failed run.
- Preserve evidence when a run has started meaningful work or the failure cause is uncertain.
- Check active processes before removing or overwriting runtime artifacts.

## Engineering rules

- Prefer the smallest change that completes the requested behavior.
- Do not use cryptographic checksums for paper identity or cache keys.
- Keep model API keys in local environment/configuration; never place them in browser bundles or Git.
- The paper agent uses the installed `pi` CLI. Translation calls the configured model API directly and does not use pi.
- Surface actionable errors; do not silently swallow failures or add speculative fallbacks.

## Verification

- Run focused unit tests and `npm run check` before committing.
- Commit code, tests, configuration, scripts, and documentation in coherent stages.
- Do not push, rebase, or rewrite history without explicit user approval.
