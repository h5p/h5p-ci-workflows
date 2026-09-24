import {
  CATEGORY,
  classifyPullRequest,
  evaluatePolicy,
  requiredCheckState,
  resolveOwners
} from './pull-request-policy.mjs';

const COMMENT_MARKER = '<!-- h5p-managed-policy -->';
const DEFAULT_CHECK_NAME = 'H5P policy approval';

/**
 * Reads the root CODEOWNERS file from the trusted base ref.
 * @param {Object} github GitHub client supplied by actions/github-script.
 * @param {string} owner Repository owner.
 * @param {string} repo Repository name.
 * @param {string} ref Trusted base branch or commit.
 * @returns {Promise<string>} Raw CODEOWNERS file text. Empty string if the file is missing.
 */
async function readCodeowners(github, owner, repo, ref) {
  const path = 'CODEOWNERS';

  try {
    const response = await github.rest.repos.getContent({ owner, repo, path, ref });
    if (!Array.isArray(response.data) && response.data.content) {
      return Buffer.from(response.data.content, response.data.encoding || 'base64').toString('utf8');
    }
  }
  catch (error) {
    if (error.status !== 404) {
      throw error;
    }
  }

  return '';
}

function dependabotMetadata(environment, outcome) {
  if (outcome !== 'success') {
    return { valid: false };
  }

  return {
    valid: true,
    updateType: environment.DEPENDABOT_UPDATE_TYPE,
    previousVersion: environment.DEPENDABOT_PREVIOUS_VERSION,
    newVersion: environment.DEPENDABOT_NEW_VERSION,
    dependencies: String(environment.DEPENDABOT_DEPENDENCIES || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  };
}

function hasRemovedFiles(files) {
  return files.some((file) => String(file.status || '').toLowerCase() === 'removed');
}

/**
 * Returns true if all commits are authored by dependabot[bot] and verified.
 * @param {Array} commits - The list of commits to evaluate.
 * @returns {boolean} - True if all commits are trusted, false otherwise.
 */
function commitsAreTrusted(commits) {
  return commits.length > 0 && commits.every((commit) => {
    const author = commit.author && commit.author.login;
    const verified = commit.commit && commit.commit.verification && commit.commit.verification.verified === true;
    return verified && author === 'dependabot[bot]';
  });
}

/**
 * Returns a map of the latest review states for each user, filtered by the specified head SHA.
 * @param {Array} reviews - The list of reviews to evaluate.
 * @param {string} headSha - The head SHA to filter reviews by.
 * @returns {Map} - A map of user logins to their latest review state.
 */
function latestReviewStates(reviews, headSha) {
  const states = new Map();

  for (const review of reviews) {
    const login = review.user && review.user.login;
  
    if (!login || (review.commit_id && review.commit_id !== headSha)) {
      continue;
    }

    const state = String(review.state || '').toUpperCase();
    if (state === 'COMMENTED' || state === 'PENDING') {
      continue;
    }

    states.set(login, state);
  }

  return states;
}

/**
 * Splits a CODEOWNER string into its type and identifier.
 * @param {string} owner - The CODEOWNER string to split.
 * @returns {Object} - An object containing the type and identifier of the owner.
 */
function splitOwner(owner) {
  const value = String(owner).replace(/^@/, '');
  const separator = value.indexOf('/');

  if (separator === -1) {
    return { type: 'user', login: value };
  }

  return {
    type: 'team',
    organization: value.slice(0, separator),
    slug: value.slice(separator + 1)
  };
}

/**
 * Resolves the review targets (users and teams) from a list of CODEOWNER strings.
 * @param {Array} owners - The list of CODEOWNER strings to resolve.
 * @param {string} repositoryOwner - The owner of the repository to filter teams by.
 * @returns {Object} - An object containing arrays of user logins and team slugs.
 */
function reviewTargets(owners, repositoryOwner) {
  const users = new Set();
  const teams = new Set();

  for (const owner of owners) {
    const target = splitOwner(owner);
    if (target.type === 'user') {
      users.add(target.login);
    }
    else if (target.organization === repositoryOwner) {
      teams.add(target.slug);
    }
  }

  return { users: [...users], teams: [...teams] };
}

function teamSlug(team) {
  return team && (team.slug || team.name);
}

function teamWasRequested(timeline, slug) {
  return timeline.some((event) => (
    event.event === 'review_requested' && teamSlug(event.requested_team) === slug
  ));
}

/**
 * Checks if there is an applicable owner approval for the given head SHA.
 * @param {Array} reviews - The list of reviews to evaluate.
 * @param {Array} owners - The list of CODEOWNER strings to check against.
 * @param {string} headSha - The head SHA to filter reviews by.
 * @param {Array} requestedTeams - Teams currently requested on the pull request.
 * @param {Array} timeline - Issue timeline events for the pull request.
 * @returns {boolean} - True if there is an applicable owner approval, false otherwise.
 */
function hasApplicableOwnerApproval(reviews, owners, headSha, requestedTeams = [], timeline = []) {
  const approvedUsers = [...latestReviewStates(reviews, headSha).entries()]
    .filter(([, state]) => state === 'APPROVED')
    .map(([login]) => login);

  if (approvedUsers.length === 0) {
    return false;
  }

  const pendingSlugs = new Set((requestedTeams || []).map(teamSlug).filter(Boolean));

  for (const owner of owners) {
    const target = splitOwner(owner);
    if (target.type === 'user' && approvedUsers.includes(target.login)) {
      return true;
    }

    if (
      target.type === 'team' &&
      teamWasRequested(timeline, target.slug) &&
      !pendingSlugs.has(target.slug)
    ) {
      return true;
    }
  }

  return false;
}

function managedCommentBody(message) {
  return `${COMMENT_MARKER}
${message}`;
}

async function upsertManagedComment(github, location, comments, body) {
  const existing = comments.find((comment) => String(comment.body || '').includes(COMMENT_MARKER));

  if (existing) {
    if (existing.body !== body) {
      await github.rest.issues.updateComment({
        owner: location.owner,
        repo: location.repo,
        comment_id: existing.id,
        body
      });
    }
    return existing.id;
  }

  const response = await github.rest.issues.createComment({
    owner: location.owner,
    repo: location.repo,
    issue_number: location.pullNumber,
    body
  });

  return response.data.id;
}

function latestPolicyCheck(checkRuns, name) {
  return checkRuns
    .filter((run) => run.name === name)
    .sort((left, right) => new Date(right.started_at || 0) - new Date(left.started_at || 0))[0];
}

function policyState(classification, pullNumber, headSha) {
  return JSON.stringify({
    version: 1,
    pullNumber,
    headSha,
    category: classification.category,
    reason: classification.reason
  });
}

function readPolicyState(checkRun, pullNumber, headSha) {
  if (!checkRun?.external_id) {
    return null;
  }

  try {
    const state = JSON.parse(checkRun.external_id);
    if (state.version !== 1 || state.pullNumber !== pullNumber || state.headSha !== headSha) {
      return null;
    }
    return { category: state.category, reason: state.reason };
  }
  catch {
    return null;
  }
}

function manualMergeRestriction(classification, removedFiles) {
  if (removedFiles) {
    return 'This pull request removes one or more files and cannot be auto-merged.';
  }

  if (classification.category === CATEGORY.DEPENDENCY_REVIEW) {
    return 'This Dependabot update is not an eligible stable patch and cannot be auto-merged.';
  }

  return null;
}

function pendingValidationFeedback(restriction, ownerSummary) {
  if (restriction) {
    return {
      conclusion: null,
      title: 'Manual merge required',
      summary: `${restriction} Validation has not completed. ${ownerSummary}`,
      message: `${restriction} H5P Automation will keep this pull request open for manual review and merge.`
    };
  }

  return {
    conclusion: null,
    title: 'Waiting for required checks',
    summary: `Validation has not completed. ${ownerSummary}`,
    message: 'H5P Automation is waiting for all configured validation checks to finish.'
  };
}

/**
 * Upserts a policy check run for the given pull request.
 * @param {Object} github - The GitHub API client.
 * @param {Object} location - The location of the pull request (owner, repo, pullNumber, pullUrl, headSha).
 * @param {Array} checkRuns - The list of existing check runs for the pull request.
 * @param {Object} input - The input data for the policy check (name, externalId, conclusion, title, summary).
 * @returns {Promise<number>} - The ID of the upserted check run.
 */
async function upsertPolicyCheck(github, location, checkRuns, input) {
  const existing = latestPolicyCheck(checkRuns, input.name);
  const desiredStatus = input.conclusion === null ? 'in_progress' : 'completed';
  if (
    existing &&
    existing.status === desiredStatus &&
    (input.conclusion === null || existing.conclusion === input.conclusion) &&
    existing.output?.title === input.title
  ) {
    return existing.id;
  }

  const request = {
    owner: location.owner,
    repo: location.repo,
    name: input.name,
    details_url: location.pullUrl,
    external_id: input.externalId,
    output: { title: input.title, summary: input.summary }
  };

  if (input.conclusion === null) {
    request.status = 'in_progress';
    request.started_at = new Date().toISOString();
  }
  else {
    request.status = 'completed';
    request.conclusion = input.conclusion;
    request.completed_at = new Date().toISOString();
  }

  if (existing && existing.status !== 'completed') {
    await github.rest.checks.update({ ...request, check_run_id: existing.id });
    return existing.id;
  }

  const response = await github.rest.checks.create({ ...request, head_sha: location.headSha });
  return response.data.id;
}

function policyFeedback(result, classification, owners, ownerApproved, removedFiles) {
  const ownerSummary = `Resolved maintainer: ${owners.join(', ')}.`;
  const classificationSummary = `${classification.category}: ${classification.reason} ${ownerSummary}`;
  const unresolvedConclusion = result.approvalRequired && !ownerApproved ? null : 'failure';
  const restriction = manualMergeRestriction(classification, removedFiles);

  if (result.decision === 'wait-for-required-checks') {
    return pendingValidationFeedback(restriction, ownerSummary);
  }

  if (result.decision === 'would-enable-auto-merge') {
    return {
      conclusion: 'success',
      title: 'Approval policy passed',
      summary: classificationSummary,
      message: 'Pull request is eligible for auto merge if all required validation checks pass.'
    };
  }

  if (result.decision === 'keep-open-after-owner-review') {
    return {
      conclusion: ownerApproved || !result.approvalRequired ? 'success' : unresolvedConclusion,
      title: 'Approval recorded; manual merge required',
      summary: classificationSummary,
      message: restriction
        ? `${restriction} H5P Automation will keep this pull request open for manual review and merge.`
        : 'Approval recorded. H5P Automation will keep this pull request open for manual merge.'
    };
  }

  const messages = {
    'request-owner-review': `${owners.join(', ')} approval requested.`,
    'keep-open-and-notify-owner': 'H5P Automation will keep this pull request open because a policy condition is not satisfied.',
    'stop-for-changed-head': 'H5P Automation will stop because the pull request changed during policy evaluation.'
  };

  return {
    conclusion: unresolvedConclusion,
    title: 'Manual review required',
    summary: classificationSummary,
    message: messages[result.decision] || 'H5P Automation will keep this pull request open until the policy can be evaluated.'
  };
}

/**
 * Requests missing user CODEOWNERS. Team reviewers are left to GitHub's native CODEOWNERS request.
 * Assigning teams from this workflow would require a GitHub App with organization members read.
 * @param {Object} github - The GitHub API client.
 * @param {Object} location - The location of the pull request (owner, repo, pullNumber).
 * @param {Object} currentPull - The current pull request data.
 * @param {Array} owners - The list of CODEOWNER strings to request reviews from.
 */
async function requestMissingReviews(github, location, currentPull, owners) {
  const targets = reviewTargets(owners, location.owner);
  const currentUsers = new Set((currentPull.requested_reviewers || []).map((user) => user.login));
  const author = currentPull.user && currentPull.user.login;
  const reviewers = targets.users.filter((login) => !currentUsers.has(login) && login !== author);

  if (reviewers.length === 0) {
    return;
  }

  await github.rest.pulls.requestReviewers({
    owner: location.owner,
    repo: location.repo,
    pull_number: location.pullNumber,
    reviewers
  });
}

async function removeOptionalOwnerReviews(github, location, currentPull, owners) {
  const targets = reviewTargets(owners, location.owner);
  const ownerUsers = new Set(targets.users);
  const ownerTeams = new Set(targets.teams);
  const reviewers = (currentPull.requested_reviewers || [])
    .map((user) => user.login)
    .filter((login) => ownerUsers.has(login));
  const teamReviewers = (currentPull.requested_teams || [])
    .map((team) => team.slug)
    .filter((slug) => ownerTeams.has(slug));

  if (reviewers.length === 0 && teamReviewers.length === 0) {
    return;
  }

  await github.rest.pulls.removeRequestedReviewers({
    owner: location.owner,
    repo: location.repo,
    pull_number: location.pullNumber,
    reviewers,
    team_reviewers: teamReviewers
  });
}

function mergeMethod(value) {
  const normalized = String(value || 'merge').toUpperCase();

  if (!['MERGE', 'SQUASH', 'REBASE'].includes(normalized)) {
    throw new Error(`Unsupported merge method: ${value}`);
  }

  return normalized;
}

/**
 * Enables auto-merge for the given pull request.
 * GraphQL API is used because the REST API does not support enabling auto-merge.
 * 
 * @param {Object} github - The GitHub API client.
 * @param {string} pullRequestId - The ID of the pull request.
 * @param {string} method - The merge method to use (merge, squash, rebase).
 */
async function enableAutoMerge(github, pullRequestId, method) {
  await github.graphql(`
    mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
      enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
        pullRequest { id }
      }
    }
  `, { pullRequestId, mergeMethod: mergeMethod(method) });
}
async function eventPullRequest(github, context) {
  if (context.payload.pull_request) {
    return context.payload.pull_request;
  }

  const workflowRun = context.payload.workflow_run;
  if (!workflowRun || workflowRun.event !== 'pull_request') {
    return null;
  }

  if (workflowRun.pull_requests?.length > 0) {
    return workflowRun.pull_requests[0];
  }

  const pulls = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, {
    ...context.repo,
    commit_sha: workflowRun.head_sha,
    per_page: 100
  });

  const associatedPull = pulls.find((pull) => (
    pull.state === 'open' && pull.head.sha === workflowRun.head_sha
  ));
  if (associatedPull) {
    return associatedPull;
  }

  // GitHub may omit PR associations for workflow runs whose head is in a fork.
  const headOwner = workflowRun.head_repository?.owner?.login;
  if (!headOwner || !workflowRun.head_branch) {
    return null;
  }

  const branchPulls = await github.paginate(github.rest.pulls.list, {
    ...context.repo,
    state: 'open',
    head: `${headOwner}:${workflowRun.head_branch}`,
    per_page: 100
  });

  return branchPulls.find((pull) => pull.head.sha === workflowRun.head_sha) || null;
}

async function disableAutoMerge(github, pullRequestId) {
  await github.graphql(`
    mutation DisableAutoMerge($pullRequestId: ID!) {
      disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
        pullRequest { id }
      }
    }
  `, { pullRequestId });
}

/**
 * Runs the pull request policy enforcement logic.
 * @param {Object} params - The parameters for the run function.
 * @param {Object} params.github - The GitHub API client.
 * @param {Object} params.context - The GitHub Actions context.
 * @param {Object} params.core - The GitHub Actions core module.
 * @param {Object} params.config - The configuration for the policy enforcement.
 * @param {Object} [params.environment=process.env] - The environment variables (default: process.env).
 * @returns {Promise<Object>} - The result of the policy enforcement, including classification, owners, checkState, approvalSatisfied, and decision.
 */
async function run({ github, context, core, config, environment = process.env }) {
  const { owner, repo } = context.repo;
  const triggeredPull = await eventPullRequest(github, context);
  if (!triggeredPull) {
    core.notice('No pull request is associated with this policy event.');
    return { decision: 'stop-without-pull-request' };
  }

  const pullNumber = triggeredPull.number;
  const initialHeadSha = triggeredPull.head.sha;
  const pullResponse = await github.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  const currentPull = pullResponse.data;
  if (currentPull.draft) {
    core.notice('Skipping draft pull request.');
    return { decision: 'skip-draft' };
  }
  if (currentPull.state !== 'open' || currentPull.merged) {
    core.notice('Pull request is not open.');
    return { decision: 'stop-without-pull-request' };
  }

  const baseRef = currentPull.base.ref;
  const [files, commits, reviews, checks, comments, codeowners, timeline] = await Promise.all([
    github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: pullNumber, per_page: 100 }),
    github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number: pullNumber, per_page: 100 }),
    github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: pullNumber, per_page: 100 }),
    github.paginate(github.rest.checks.listForRef, { owner, repo, ref: initialHeadSha, per_page: 100 }),
    github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pullNumber, per_page: 100 }),
    readCodeowners(github, owner, repo, baseRef),
    github.paginate(github.rest.issues.listEventsForTimeline, { owner, repo, issue_number: pullNumber, per_page: 100 })
  ]);

  if (currentPull.head.sha !== initialHeadSha) {
    core.notice('The pull request head changed during policy evaluation.');
    return { decision: 'stop-for-changed-head' };
  }

  const changedFiles = [...new Set(files.flatMap((file) => (
    [file.filename, file.previous_filename].filter(Boolean)
  )))];
  const removedFiles = hasRemovedFiles(files);
  const metadata = dependabotMetadata(environment, config.dependabotMetadataOutcome);
  const trustedCommits = commitsAreTrusted(commits);
  const checkRuns = checks.flatMap((page) => page.check_runs || page);
  const checkName = config.policyCheckName || DEFAULT_CHECK_NAME;
  const savedClassification = context.payload.workflow_run
    ? readPolicyState(latestPolicyCheck(checkRuns, checkName), pullNumber, initialHeadSha)
    : null;
  const classification = savedClassification || classifyPullRequest({
      author: currentPull.user.login,
      changedFiles,
      translationPatterns: config.translationPatterns,
      dependabotMetadata: metadata,
      dependabotCommitsTrusted: trustedCommits
    });
  const owners = resolveOwners(changedFiles, codeowners, config.fallbackOwner);
  const ownerApproved = hasApplicableOwnerApproval(
    reviews,
    owners,
    initialHeadSha,
    currentPull.requested_teams,
    timeline
  );
  const checkState = requiredCheckState(config.requiredChecks, checkRuns);
  const autoMergeCategory = [CATEGORY.DEPENDENCY_PATCH, CATEGORY.TRANSLATION]
    .includes(classification.category);
  const autoMergeAllowed = !removedFiles && autoMergeCategory && (
    currentPull.user.login !== 'dependabot[bot]' ||
    (classification.category === CATEGORY.DEPENDENCY_PATCH && trustedCommits)
  );
  const result = evaluatePolicy({
    category: classification.category,
    autoMergeAllowed,
    checkState,
    ownerApproved,
    mergeable: currentPull.mergeable,
    headSha: currentPull.head.sha,
    evaluatedHeadSha: initialHeadSha
  });
  const feedback = policyFeedback(result, classification, owners, ownerApproved, removedFiles);
  const location = {
    owner,
    repo,
    pullNumber,
    pullUrl: currentPull.html_url,
    headSha: initialHeadSha
  };

  if (result.approvalRequired && !ownerApproved) {
    await requestMissingReviews(github, location, currentPull, owners);
  }
  else if (!result.approvalRequired) {
    await removeOptionalOwnerReviews(github, location, currentPull, owners);
  }

  const approvalSatisfied = !result.approvalRequired || ownerApproved;
  await upsertManagedComment(
    github,
    location,
    comments,
    managedCommentBody(feedback.message)
  );

  const autoMergeEligible =
    approvalSatisfied &&
    autoMergeAllowed &&
    checkState.passed &&
    currentPull.mergeable !== false;

  if (currentPull.auto_merge && !autoMergeEligible) {
    await disableAutoMerge(github, currentPull.node_id);
  }
  else if (!currentPull.auto_merge && autoMergeEligible) {
    await enableAutoMerge(github, currentPull.node_id, config.mergeMethod);
  }

  await upsertPolicyCheck(github, location, checkRuns, {
    name: checkName,
    externalId: policyState(classification, pullNumber, initialHeadSha),
    conclusion: feedback.conclusion,
    title: feedback.title,
    summary: feedback.summary
  });

  await core.summary
    .addHeading('H5P pull request policy enforcement')
    .addTable([
      [{ data: 'Field', header: true }, { data: 'Value', header: true }],
      ['Category', classification.category],
      ['Approval required', String(result.approvalRequired)],
      ['Approval satisfied', String(approvalSatisfied)],
      ['Resolved owners', owners.join(', ')],
      ['Decision', result.decision],
      ['Head SHA', initialHeadSha]
    ])
    .write();
  
  core.setOutput('category', classification.category);
  core.setOutput('decision', result.decision);
  core.setOutput('owners', JSON.stringify(owners));
  return { classification, owners, checkState, approvalSatisfied, ...result };
}

export {
  COMMENT_MARKER,
  DEFAULT_CHECK_NAME,
  commitsAreTrusted,
  dependabotMetadata,
  enableAutoMerge,
  eventPullRequest,
  hasRemovedFiles,
  hasApplicableOwnerApproval,
  managedCommentBody,
  mergeMethod,
  policyFeedback,
  policyState,
  readPolicyState,
  removeOptionalOwnerReviews,
  requestMissingReviews,
  readCodeowners,
  reviewTargets,
  run,
  upsertManagedComment,
  upsertPolicyCheck
};
