# @mvsantosdev/dsh-jev

[![CI](https://github.com/mvsantosdev/dsh-jev/actions/workflows/ci.yml/badge.svg)](https://github.com/mvsantosdev/dsh-jev/actions/workflows/ci.yml)

Jev (TypeSafe System One decision model) is a Cordis plugin suite for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

> [!NOTE]
> This repository, [mvsantosdev/dsh-jev](https://github.com/mvsantosdev/dsh-jev), is a fork of [zhangxaochen/dsh-jev](https://github.com/zhangxaochen/dsh-jev).
> [@zhangxaochen](https://github.com/zhangxaochen) is the original author and creator of Jev and its core implementation. This fork is maintained by [@mvsantosdev](https://github.com/mvsantosdev).
>
> Version **0.2.1** of this fork adds:
> - DeepSeek Harness Desktop enable/disable toggle compatibility;
> - an English user-facing Jev dashboard and metrics UI;
> - scoped npm distribution as `@mvsantosdev/dsh-jev`.
>
> The original MIT license and copyright attribution are preserved.

Jev supplies the semantic judgment layer that DSH itself lacks: it introduces non-generative decision primitives (Noul, Choice, Score) with approximately 150 ms latency for **dynamic tool pruning** (reducing prompt tokens and time to first token), **semantic loop prevention**, and **safety gating for high-risk execution**. Decisions use System One rather than generative sampling, making them fast, reproducible, and nearly cost-free.

## Contents

- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Division of responsibilities with DSH built-ins](#division-of-responsibilities-with-dsh-built-ins)
- [Development and verification](#development-and-verification)
- [Contributing](#contributing)
- [License](#license)

## Features

| Module | Service / hook | Purpose |
| :--- | :--- | :--- |
| `typesafe-client` | Registers `ctx.typesafe` | Wraps the System One API: concurrent evaluation of multiple questions in one request, timeout retries, and test mocks. |
| `typesafe-loop-guard` | `tools/post-execute` | Semantically judges whether each step makes real progress toward solving the task, blocks loops, and injects corrective guidance into `additionalContexts` (approximate stagnation that argument-hash deduplication cannot detect). |
| `typesafe-safety-guard` | `tools/pre-execute` | Reviews high-risk shell / file operations in milliseconds (`rm -rf`, privilege escalation, credential leaks), blocking them (`deny`) or requesting approval (`ask`). |
| `typesafe-tool-pruner` | `ctx.toolPruner` | When dozens or hundreds of tools are available, injects only the most relevant Top-K tools for the intent, removing large portions of tool schemas. |
| `jev_ask` / `jev_rank` / `jev_check` | Agent tools | Gives the model direct access to decision primitives: batch questions, ranking by criteria, and assertion verification (true / false / indeterminate). |
| `typesafe-skill-router` | `system-prompt/assemble` | For large skill catalogs, identifies **one** skill that should be loaded and injects a recommendation (without blocking or removing anything). |
| `typesafe-result-shaper` | `tools/post-execute` (**disabled by default**) | Keeps only informative middle sections of excessively long, repetitive command output and discards the rest. |

Measured output from a complete `pnpm run verify:turn` turn (all modules + a real model + real assembly):

```text
assemble:       2139ms -> 12 tools to 5 (edit_file,git_commit,git_push,read_file,run_tests)
skill intent:   Turn this user research into a PRD document -> 1 advice in 979ms
post-execute:   586ms -> 32680 to 237 chars
semantic overhead this turn: 3704ms
```

In `verify:live`, a real loop was detected with `pLoop=0.88` and confidence `0.81`, while a healthy trajectory with `pLoop=0.00` did not trigger the guard. Values vary with request and output size; threshold rationale and full calibration are documented in [`docs/calibration.md`](docs/calibration.md).

## Installation

**Requirements**: Node `^22.19.0 || >=24.0.0`; DSH `>=0.1.5-rc.2`. The plugin hooks into `tools.guard()`, `tools/pre-execute`, `tools/post-execute`, `system-prompt/assemble`, and `agent/pre-step`, and reads the `tokenMeter` / `skills` / `toolResultPruner` services as needed. It follows fallback paths when these services are unavailable.

For ordinary DSH profiles:

```bash
# Install this fork directly from GitHub (no npm release required; uses the current code)
dsh plugin --profile <profile_name> add github:mvsantosdev/dsh-jev

# Install the scoped npm package
dsh plugin --profile headless add @mvsantosdev/dsh-jev

# Install the npm package in a local project
npm install @mvsantosdev/dsh-jev
```

> ⚠️ **The `desktop` profile cannot be installed this way.** The CLI rejects it with:
> `error: profile "desktop" is managed exclusively by the Electron application`.
> For Desktop, install through the application's plugin interface when available.
> For local development and testing, see
> [Development and verification](#development-and-verification).
>
> `dsh plugin` has no subcommands of its own: it **forwards arguments to pnpm in the profile directory** (observed error:
> `plugin needs pnpm arguments to forward (e.g. add <package>)`). Thus, `add` / `remove` / `list` have pnpm semantics.

Package identities are distinct:

| Identity | Value |
|---|---|
| npm package | `@mvsantosdev/dsh-jev` |
| Cordis package name | `@mvsantosdev/dsh-jev` |
| Client module ID | `@mvsantosdev/dsh-jev` |
| Internal Cordis/runtime ID | `dsh-jev` |

The scoped package name determines the installation path (`node_modules/@mvsantosdev/dsh-jev` for local development). Internal runtime identifiers and API routes, including `/api/dsh-jev/...`, retain `dsh-jev`.

## Usage

Set the **API key** in `$DSH_HOME/.env` (default: `~/.dsh/.env`, automatically loaded at startup by Desktop and all CLI profiles), or set the environment variable of the same name. Without a key, DSH does not crash: the plugin logs a warning and runs in Mock mode, but cannot request cloud arbitration.

```bash
TYPESAFE_API_KEY=your_typesafe_api_key_here
```

The plugin works immediately after installation. Defaults are calibrated, so **no configuration changes are required**:

- **Status-bar toggle**: click the `jev` switcher below the input box to enable/disable all modules without uninstalling or restarting (see the configuration manual for disable semantics).
- **Decision primitives** are registered as Agent tools; the model can call `jev_ask` / `jev_rank` / `jev_check` directly.
- **Dashboard**: ask the Agent to execute `jev_stats`, or request `GET /api/dsh-jev/stats` (browsers receive an HTML dashboard; `Accept: application/json` returns JSON). Metrics persist in `~/.dsh/jev-stats.json`.

For threshold changes, custom safety rules, or embedding in a Cordis host outside DSH, see [`docs/configuration.md`](docs/configuration.md), which includes all fields, defaults, and their rationale.

## Division of responsibilities with DSH built-ins

Jev supplies only the layer that DSH itself lacks, avoiding duplication and conflicting behavior:

| Scenario | Owner | Reason |
|---|---|---|
| Identical repeated calls (tool + arguments + output) | DSH `dsh-repeat-tool-reminder` (thresholds 3/5/8) | Deterministic exact matching is sufficient; dsh-jev yields by default with `loopGuard.deferExactRepeats: true`. |
| **Approximate / semantic stagnation** | dsh-jev `loop-guard` | The built-in package explicitly excludes synonymous variants for lack of evidence; this plugin fills the gap using loop-bucket probability + confidence. |
| Head/tail truncation of excessively long results | DSH `dsh-spill-policy`, `dsh-compaction-tool-result-pruner` | Both provide model-free, zero-cost, reproducible safe replacements. |
| **Semantic selection of middle sections** | dsh-jev `result-shaper` (disabled by default) | The built-in package's Dev Note lists "semantic middle selection" as unimplemented; this plugin fills only that gap. |
| Hard denial of dangerous commands | dsh-jev deterministic envelope (`ctx.tools.guard()`) | Synchronous, monotonic, and requires 0 model calls; the semantic layer is not the final safeguard. |
| Semantic risk judgments / user-defined rules | dsh-jev `safety-guard` | Forms outside the pattern list require semantic judgment. |

## Development and verification

Tests use Node's native test runner. Offline cases do not access the network or require a key (mocks are built in):

```bash
pnpm install --frozen-lockfile
pnpm run build && pnpm run verify:build   # lib/ is committed and imported by unit tests; changing src without rebuilding must fail
pnpm test                                 # Offline unit tests (case count grows with releases; consult the output)
pnpm run verify:dsh                       # Real DSH runtime (skips and exits 0 if DSH is not installed; suitable for CI)
pnpm run verify:live                      # Online: replay historical false-positive patterns; confirm they no longer trigger and real loops are still blocked
pnpm run bench:offline                    # A/B benchmark replaying recorded answers; zero cost, no key required
pnpm run doctor                           # Deployment check: is the local installation running the current build?
```

Commands and evidence for the other gates—`probe` / `verify:tools` / `verify:pruner` / `verify:router` / `verify:shaper` / `verify:turn` / `verify:pack` / `verify:mutants` / `verify:solo` / `drill` / `bench` / coverage audits—are in [`docs/verification-report.md`](docs/verification-report.md). Inspirations and supporting evidence are in [`docs/research.md`](docs/research.md). Behavior changes and **upgrade steps** are in [`CHANGELOG.md`](CHANGELOG.md) (breaking changes are documented there only, rather than repeated here).

CI (`.github/workflows/ci.yml`) runs `build → typecheck:scripts → test → bench:offline → verify:dsh (skipped) → package verification` on Node 22 and 24. The benchmark replays offline recordings with **input fingerprint validation**, so no API key is required. **Any behavior mismatch in a case not marked as a known false negative causes CI to fail.**

### Applying local changes

Plugins in profiles are **copies of build artifacts**. After changing source code, synchronize them and restart DSH:

```bash
pnpm run sync              # Synchronize all profiles with this plugin installed (automatically discovered)
pnpm run sync:desktop      # Synchronize desktop only
pnpm run doctor            # Compare build hashes, installed versions, and metrics schemas per profile; prints ACTION: or OK:
```

`pnpm run sync` also aligns the `@mvsantosdev/dsh-jev` version declared in profile manifests with this repository's version. The declaration pins an exact version, while the installed copy is **replaced in place**. If they drift, any subsequent `pnpm install` in that profile (also run by `dsh plugin add`) can **silently replace** the new version with the declared version. `doctor` reports this drift (`declaredMatch`). Verification scripts do not contaminate live metrics: `verify:*` / `bench` write metrics and decision logs to `%TEMP%` (`DSH_JEV_METRICS_PATH` / `DSH_JEV_DECISIONS_PATH`). Otherwise, tests would overwrite `~/.dsh/jev-stats.json`, which `doctor` relies on to assess deployment state.

> ⚠️ **DSH must be restarted**: the profile combination in this deployment does not include an HMR plugin, so a running process will not reload modules under `node_modules`. Synchronizing without restarting leaves the session on the old build (`doctor` explicitly reports `ACTION: restart DSH`).

## Contributing

Issues and PRs are welcome. Changes must meet these requirements:

- `pnpm test` passes completely (including the order-independence checks in `verify:solo` and mutation scans in `verify:mutants`).
- Behavior changes are reflected in [`CHANGELOG.md`](CHANGELOG.md); new gates update the evidence table in [`docs/verification-report.md`](docs/verification-report.md) (the table must list every `verify:*` script, enforced by a test).
- Adding or removing configuration fields requires updating [`docs/configuration.md`](docs/configuration.md) (documentation coverage of fields is also enforced by tests).

### Releases

Publishing is triggered by **pushing a tag**: `.github/workflows/release.yml` listens for `v*` tags, runs the full CI gates, checks that the tag matches the `package.json` version and that CHANGELOG contains a section for that version (a mismatch fails the release), then runs `npm publish --provenance` and creates a GitHub Release using that CHANGELOG section. Branch pushes never trigger publishing.

```bash
# 1. Update package.json's version and add a ## [x.y.z] section to CHANGELOG
# 2. After committing, create and push the tag
git tag v0.2.1 && git push origin v0.2.1
```

One-time setup (cannot be completed from the repository alone): in the npmjs.com settings for `@mvsantosdev/dsh-jev`, configure **Trusted Publisher** for GitHub Actions with repository `mvsantosdev/dsh-jev` and workflow filename `release.yml` (leave environment blank). CI then uses OIDC to obtain short-lived publishing credentials with provenance; no `NPM_TOKEN` is required.

Fork maintainer: [@mvsantosdev](https://github.com/mvsantosdev)

Original author and core implementation creator: [@zhangxaochen](https://github.com/zhangxaochen)

## License

[MIT](LICENSE) — Copyright (c) 2026 zhangxaochen.
