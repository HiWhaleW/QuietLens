import { DIMENSIONS } from "./data.js";

export function adjustedScores(cafe, visitTime) {
  const change = visitTime === "weekdayMorning" ? 6 : visitTime === "weekend" ? -cafe.weekendPenalty : 0;
  return {
    ...cafe.scores,
    quiet: clamp(cafe.scores.quiet + Math.round(change * 0.7)),
    uncrowded: clamp(cafe.scores.uncrowded + change),
  };
}

export function scoreCafe(cafe, preferences, visitTime) {
  const displayScores = adjustedScores(cafe, visitTime);
  const weighted = DIMENSIONS.reduce(
    (total, dimension) => total + displayScores[dimension] * preferences[dimension],
    0,
  );
  const weightTotal = DIMENSIONS.reduce((total, dimension) => total + preferences[dimension], 0);

  return {
    ...cafe,
    displayScores,
    matchScore: Math.round(weighted / weightTotal),
  };
}

function clamp(value) {
  return Math.max(0, Math.min(100, value));
}
