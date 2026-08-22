const PARTICIPANT_ID_PATTERN = /^beta-participant-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DELETED_COUNT_KEYS = Object.freeze([
  "session_record_count",
  "decision_request_count",
  "analytics_event_count",
  "feedback_record_count",
  "cost_observation_count",
]);

class BetaParticipantDataError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function assertDeletedCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== DELETED_COUNT_KEYS.length
    || DELETED_COUNT_KEYS.some((key) => !Object.hasOwn(value, key)
      || !Number.isSafeInteger(value[key])
      || value[key] < 0)) {
    throw new BetaParticipantDataError("BETA_DATA_STORE_INVALID", 502);
  }
  return Object.freeze(Object.fromEntries(DELETED_COUNT_KEYS.map((key) => [key, value[key]])));
}

function resolveStore(env) {
  const store = env?.QUIETLENS_BETA_DATA_STORE;
  if (!store
    || typeof store.deleteParticipantData !== "function"
    || typeof store.countParticipantData !== "function") {
    throw new BetaParticipantDataError("BETA_DATA_STORE_NOT_CONFIGURED", 503);
  }
  return store;
}

export async function deleteBetaParticipantData(env, participantId, deletedAt = new Date().toISOString()) {
  if (!PARTICIPANT_ID_PATTERN.test(participantId ?? "") || Number.isNaN(Date.parse(deletedAt))) {
    throw new BetaParticipantDataError("BETA_DATA_DELETE_INVALID", 400);
  }

  const store = resolveStore(env);
  let deletedCounts;
  let remainingRecordCount;
  try {
    deletedCounts = assertDeletedCounts(await store.deleteParticipantData(participantId));
    remainingRecordCount = await store.countParticipantData(participantId);
  } catch (error) {
    if (error instanceof BetaParticipantDataError) throw error;
    throw new BetaParticipantDataError("BETA_DATA_STORE_FAILED", 502);
  }

  if (!Number.isSafeInteger(remainingRecordCount) || remainingRecordCount < 0) {
    throw new BetaParticipantDataError("BETA_DATA_STORE_INVALID", 502);
  }
  if (remainingRecordCount !== 0) {
    throw new BetaParticipantDataError("BETA_DATA_DELETION_INCOMPLETE", 409);
  }

  const deletedRecordCount = Object.values(deletedCounts).reduce((sum, count) => sum + count, 0);
  return Object.freeze({
    schema_version: "1.0.0",
    deleted: true,
    deleted_at: deletedAt,
    deleted_record_count: deletedRecordCount,
    deleted_counts: deletedCounts,
    remaining_record_count: 0,
  });
}
