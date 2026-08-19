const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLocalEvidenceReviewWorkbenchLocation(locationLike) {
  if (!LOCAL_HOSTS.has(locationLike?.hostname)) return false;
  const params = new URLSearchParams(locationLike?.search ?? "");
  return params.get("workbench") === "evidence-review";
}

export function isLocalEvidenceReviewerAuthLocation(locationLike) {
  if (!LOCAL_HOSTS.has(locationLike?.hostname)) return false;
  const params = new URLSearchParams(locationLike?.search ?? "");
  return params.get("workbench") === "evidence-review-auth";
}
