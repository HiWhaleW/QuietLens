export function sceneNoticeForPlace({ candidate, nonRecommendationText, unknownLabel }) {
  if (candidate) {
    const tradeoff = candidate.tradeoffs?.find((item) => item?.text)?.text;
    if (tradeoff) return { kind: "conflict", label: "可能冲突", text: tradeoff };

    const unknown = candidate.unknowns?.[0];
    if (unknown) {
      return {
        kind: "unknown",
        label: "待核实",
        text: `${unknownLabel?.(unknown) ?? unknown}仍缺少当前证据`,
      };
    }
    return null;
  }

  return nonRecommendationText
    ? { kind: "not-recommended", label: "本轮未推荐", text: nonRecommendationText }
    : null;
}
