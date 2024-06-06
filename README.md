# h5p-ci-workflows
CI workflows for H5P Libraries

The reusable workflow is a CI pipeline shared among H5P libraries.

The `h5p-ci-workflow` is triggered on `workflow_call` by the respective libraries on new pull resuests to master or new commits to an existing pull request. 
The libraries pass along arguments (booleans) for which steps that are to be run as part of the reusable workflow, e.g. `run-translations` and `pack`.

If the reusable workflow fail, the checks for the PR in the library will fail, and the user is notified. 