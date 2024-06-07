# h5p-ci-workflows
CI workflows prototype for H5P Libraries

The reusable workflow is a CI pipeline that can shared among H5P libraries.

The `h5p-ci-workflow` is triggered on `workflow_call` by the respective libraries (callers) on new pull resuests to master or new commits to an existing pull request. 
The initial step of the `reusable-workflow` job checks out the repository of the caller. The caller pass along arguments (booleans) for which steps that are to be run as part of the reusable workflow, e.g. `run-translations` and `pack`. 

