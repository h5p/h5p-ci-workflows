# h5p-ci-workflows
Reusable workflow shared among H5P Libraries. Intented used as part of a CI pipeline covering e.g. validation, packing, bumping, linting, etc. 
The reusable workflow currently supports two checks, each toggled by a `with` flag from the caller:
- `run-translations` — validation of translation files for H5P Libraries.
- `run-e2e` — running the content type's Playwright E2E suite against the PR branch (see [content-type-e2e](#content-type-e2e)).

## Workflow Caller
The `h5p-ci-workflow` is triggered on a `workflow_call` by the respective libraries (callers) on new pull requests to a specified branch in the caller or new commits to an existing pull request of the same branch. 
The triggering logic is implemented as a small GitHub Actions Workflow in the respective caller repository. Example: 

```
name: CI

concurrency:
  group: ct-e2e-${{ github.repository }}-${{ github.ref }}
  cancel-in-progress: true

on:
  workflow_dispatch:
  pull_request:
    branches:
      - master
    types: [opened, synchronize]
    paths-ignore:
      - '**.md'
      - 'LICENSE*'
      - '.gitignore'

jobs:
  ci:
    permissions:
      contents: read
      packages: read
      actions: write
    uses: h5p/h5p-ci-workflows/.github/workflows/h5p-ci-workflow.yml@master
    with:
      run-translations: true
      run-e2e: true
    secrets: inherit
```

### Caller adoption checklist (`run-e2e: true`)

Copy these on the caller workflow, not only the `run-e2e` flag:

- `concurrency` with `group: ct-e2e-${{ github.repository }}-${{ github.ref }}` and `cancel-in-progress: true` (latest push wins; other CT repos are unaffected)
- `paths-ignore` for docs-only changes (`**.md`, `LICENSE*`, `.gitignore`)
- `permissions` with `packages: read` so the job can pull `ghcr.io/h5p/ct-e2e`
- `secrets: inherit` for the GitHub App that can read `h5pcom-e2e-tests` (`E2E_ID`, `E2E_PRIVATE_KEY`)
- Optional: `workflow_dispatch` so the suite can be re-run from Actions without a new commit

- The `types: [opened, synchronize]` specify that the reusable workflow should be triggered on Pull Requests to master and updates open Pull Request to master.
- The `uses` field of the `ci` job targets the reusable workflow master branch.
- The `with` field toggles which checks run: `run-translations` and/or `run-e2e`. Each maps to a job in the reusable workflow that only runs when its flag is true, so a single caller job drives both checks.
- `secrets: inherit` forwards the org secrets used for E2E (`E2E_ID` and `E2E_PRIVATE_KEY` — a GitHub App with read access to `h5pcom-e2e-tests`). Only needed when `run-e2e: true`.

## validate-translations
The `validate-translations` job is run depending on the input from the caller. If set to true, the job installs a **pinned** `h5p-cli` ref (`h5p-cli-ref` input) and runs `h5p utils validate` on the caller repo from the root level.

## Checks
Upon opening new PRs or updating an existing PR to master, GitHub will first check for the ability to automatically merge, before proceeding with validating the translation files.

### Pass
If the translation files of the respective caller is not corrupted, the checks should pass. 

> Note that the h5p-cli is a work in progress, so not all validation cases are yet considered.
> The h5p-cli in continiously improved to ensure the quality of the translation files adhere to the H5P specification.

### Fail
If the checks don't pass, the Pull Request will state accordingly and the user creating/updating the Pull Requent will be notified per email. As the `h5p-cli` is still work in progress 
and some translation files may be corrupted (legacy) the Pull Request may still be force pushed. 

For more information as to why the check failed, the user may inspect the Details of the check being run.

## content-type-e2e
The `content-type-e2e` job (enabled with `run-e2e: true`) runs the Playwright E2E suite for a single content type against the **exact PR branch** of that content type — no deploy or test environment required. The job runs inside the shared `ghcr.io/h5p/ct-e2e` image, checks out `h5pcom-e2e-tests`, and uses the same entrypoint as local: `npm run test:cli`. That script sets up the content type from the PR branch with `h5p-cli`; Playwright serves it on `http://localhost:8080` and runs the `chromium_cli` project.

### Runtime image
Playwright, webpack, pinned `h5p-cli`, and `h5p core` live in `ghcr.io/h5p/ct-e2e` (see `docker/ct-e2e/Dockerfile`). The Dockerfile is the build source: publish reads the Playwright version and CLI SHA from it and tags `playwright-<version>-cli-<shortsha>` plus `latest`. Rebuild weekly (Monday 04:00 UTC), on Dockerfile / publish-workflow changes, or via **Publish CT E2E image** (`workflow_dispatch`).

Playwright and `h5p-cli` are pinned in the Dockerfile. `h5p core` tracks upstream (editor / php / MathDisplay) and moves when the image rebuilds. If a weekly image is bad, pin `ct-e2e-image` back to the previous tag (or re-run Publish) — do not debug core inside a content-type PR.

The CT job pulls with the **caller** repo’s `GITHUB_TOKEN`. Keep the GHCR package **internal to the `h5p` org** and allow Actions to pull it. A 403 on first pull is package settings, not missing YAML.

`validate-translations` stays on `ubuntu-latest` with its own small `h5p-cli` install (no Playwright / core).

### When it runs
Triggered by the caller on:

- `pull_request` to `master` (`opened` / `synchronize`) — PR gate
- `workflow_dispatch` — manual run (Actions → Run workflow)

Docs-only changes should be skipped via caller `paths-ignore`.

### Enabling it
There is nothing to configure per content type beyond the flag and the [caller adoption checklist](#caller-adoption-checklist-run-e2e-true) — the job derives everything it needs from the PR context:

- **library** = `${{ github.event.repository.name }}` (the caller repo name, e.g. `h5p-true-false`, which must match the folder under `libraries/` in `h5pcom-e2e-tests`).
- **branch** = `${{ github.head_ref || github.ref_name }}` (PR head branch, or the branch for `workflow_dispatch`).

Optional inputs:

- `e2e-ref` (default `main`) — which ref of `h5pcom-e2e-tests` to run from
- `h5p-cli-ref` — `h5p-cli` ref for **validate-translations only** (default matches the image CLI SHA by convention; bump independently if needed). Does not change e2e.
- `ct-e2e-image` — tagged GHCR image for the E2E job (default `ghcr.io/h5p/ct-e2e:playwright-1.57.0-cli-b33e87fd`). After publishing a new image, bump this default. Do not use `:latest` on callers.

> Requires `h5p setup <library> [ref] [download]` in `h5p-cli`, where `[ref]` is the PR branch (or a tag). Without it the CLI sets up `master` of the content type, so the suite would silently test the wrong code rather than the PR.

### How it works
1. Runs the job in `ghcr.io/h5p/ct-e2e` (Playwright Chromium, webpack, pinned `h5p-cli`, baked `h5p core`).
2. Checks out private `h5pcom-e2e-tests` via GitHub App, then `npm ci --ignore-scripts`.
3. Copies `/opt/h5p-runner` → `e2e/.h5p-cli-runner` (core already present, so `h5p core` is skipped).
4. Runs `npm run test:cli -- <repo-name> --branch=<branch>` — same command as local — which still runs `h5p setup` for the PR branch of that content type, then Playwright `chromium_cli`.
5. On **failure only**, uploads the Playwright HTML report (`playwright-report-<repo-name>`, 7 days).

### Reproducing locally
Same command as CI, from a `h5pcom-e2e-tests` checkout:

```sh
npm run test:cli -- <library> --branch=<pr-branch>
```

See that repo's README for setup, `--fresh`, and CLI-mode fixture/keyboard notes.

### Pass / Fail
Same semantics as the translation check: the E2E job appears as its own check on the PR. On failure, open the check's **Details** and download the `playwright-report-<library>` artifact for the full trace, screenshots, and per-test diagnostics.

### Known caveat: CLI host chrome vs. keyboard / a11y tests
When a content type is served by `h5p-cli`, the view page wraps the content iframe in its own focusable UI (dashboard nav, Edit/Delete/Split-View links, theme switcher, session controls). On `staging.h5p.com` the content iframe is effectively the whole page, so a "first `Tab`" lands directly on the first control inside the content.

This means **keyboard-driven a11y specs that rely on the page's global tab order can fail under `chromium_cli`** even though the content type is fine — the initial `Tab` lands on the CLI's chrome, not the content. Symptoms are `toBeFocused()` reporting `inactive` and `aria-checked` staying `false` after a keypress. Mouse/`.click()`-based specs are unaffected because they target elements directly.

This is deterministic (not flaky) and host-dependent. Keyboard specs must **establish focus inside the iframe before driving the keyboard** (e.g. `await pom.trueButton.focus()`), rather than assuming `Tab` from the page enters the content. True/False already does this; other content types should copy that pattern before enabling `run-e2e`. Page-level "tab order" assertions that test the host's traversal are not a property of the content type.
