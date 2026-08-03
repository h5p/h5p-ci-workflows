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

on:
  workflow_dispatch:
  pull_request:
    branches:
      - master
    types: [opened, synchronize]  # Triggers on PR open and commits to PR

jobs:
  ci:
    uses: h5p/h5p-ci-workflows/.github/workflows/h5p-ci-workflow.yml@master
    with:
      run-translations: true
      run-e2e: true
    secrets: inherit
```

- The `types: [opened, syncronize]` specify that the reusable workflow should be triggered on Pull Requests to master and updates open Pull Request to master.
- The `uses` field of the `ci` job targets the reusable workflow master branch.
- The `with` field toggles which checks run: `run-translations` and/or `run-e2e`. Each maps to a job in the reusable workflow that only runs when its flag is true, so a single caller job drives both checks.
- `secrets: inherit` forwards `E2E_REPO_TOKEN` (needed only when `run-e2e: true`). If you prefer not to forward all secrets, pass it explicitly instead:

```
    secrets:
      E2E_REPO_TOKEN: ${{ secrets.E2E_REPO_TOKEN }}
```

## validate-translations
The `validate-translations` job is run depending on the input from the caller. If set to true, the job will pull and install the latest version of the `h5p-cli`.
The `h5p utils validate` command is run on the caller repo from the root level. 

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
The `content-type-e2e` job (enabled with `run-e2e: true`) runs the Playwright E2E suite for a single content type against the **exact PR branch** of that content type — no deploy or test environment required. The job installs tooling and checks out `h5pcom-e2e-tests`, then runs the same entrypoint used locally: `npm run test:cli`. That script sets up the content type from the PR branch with `h5p-cli`; Playwright serves it on `http://localhost:8080` and runs the `chromium_cli` project.

### When it runs
Like `validate-translations`, it is triggered by the caller on `pull_request` to `master` with `types: [opened, synchronize]`, i.e. on PR open and on every new commit pushed to an open PR. This is the earliest possible point — regressions are caught before anything is merged or deployed.

### Enabling it
There is nothing to configure per content type beyond the flag — the job derives everything it needs from the PR context:

- **library** = `${{ github.event.repository.name }}` (the caller repo name, e.g. `h5p-true-false`, which must match the folder under `libraries/` in `h5pcom-e2e-tests`).
- **branch** = `${{ github.head_ref }}` (the PR's head branch, so the suite always tests the proposed change).

So the same single caller job shown under [Workflow Caller](#workflow-caller) is all that's needed: set `run-e2e: true` and forward `E2E_REPO_TOKEN`. Optional input `e2e-ref` (default `master`) selects which ref of `h5pcom-e2e-tests` to run the suite from.

> Requires `h5p setup <library> [ref] [download]` in `h5p-cli`, where `[ref]` is the PR branch (or a tag). Without it the CLI sets up `master` of the content type, so the suite would silently test the wrong code rather than the PR.

### How it works
1. Installs the `h5p-cli` and global build tooling (`webpack`/`webpack-cli`, needed because some content type dependencies build via `npm run build`).
2. Checks out `h5pcom-e2e-tests`, installs deps and the Chromium browser.
3. Runs `npm run test:cli -- <repo-name> --branch=<head-ref>` — same command as local. That sets up the content type at the PR branch, starts the CLI server via Playwright `webServer`, and runs `chromium_cli`.
4. Uploads the Playwright HTML report as an artifact (`playwright-report-<repo-name>`, retained 7 days).

The `chromium_cli` Playwright project sets the `isCLI` option, which the suite's centralized `resolveHelper` fixture uses to upload the local `.h5p` fixture into the running CLI server (instead of targeting a hosted staging URL).

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

This is deterministic (not flaky) and host-dependent, so it reproduces identically in CI. To make a keyboard spec host-agnostic, **establish focus inside the iframe before driving the keyboard** (e.g. focus the first content control: `await pom.trueButton.focus()`), rather than assuming `Tab` from the page enters the content. Page-level "tab order" assertions that test the host's traversal are not a pure property of the content type and may be scoped out of `chromium_cli`. Hardening these specs is a separate test-authoring task and is not required for the pipeline itself.

