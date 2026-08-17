const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export function buildEvaluationRunMetadata({ gitCommit, gitBranch, gitStatus, packageVersion }) {
  if (!GIT_COMMIT_PATTERN.test(gitCommit)) throw new Error("EVALUATION_GIT_COMMIT_INVALID");
  if (!gitBranch?.trim()) throw new Error("EVALUATION_GIT_BRANCH_INVALID");
  if (!packageVersion?.trim()) throw new Error("EVALUATION_PACKAGE_VERSION_INVALID");

  const worktreeDirty = Boolean(gitStatus.trim());
  return {
    git_commit: gitCommit,
    git_branch: gitBranch.trim(),
    worktree_dirty: worktreeDirty,
    package_version: packageVersion.trim(),
    build_id: `${gitCommit.slice(0, 12)}${worktreeDirty ? "-dirty" : ""}`,
  };
}
