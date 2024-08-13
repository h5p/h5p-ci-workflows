# h5p-ci-workflows
Reusable workflow shared among H5P Libraries. Intented used as part of a CI pipeline covering e.g. validation, packing, bumping, linting, etc. 
Currently the reusable workflow supports validation of translation files for H5P Libraries, given by the required parameter `run-translations`. 

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
```

- The `types: [opened, syncronize]` specify that the reusable workflow should be triggered on Pull Requests to master and updates open Pull Request to master.
- The `uses` field of the `ci` job targets the reusable workflow master branch.
- The `with` field let you specify whether translation validation should be run or not.

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

