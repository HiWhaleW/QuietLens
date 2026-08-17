export const initialDecisionState = {
  stage: "F0",
  status: "idle",
  request: null,
  patch: null,
  changes: [],
  clarification: null,
  brief: null,
  context: null,
  selectedPlaceId: null,
  errorCode: null,
  versions: null,
};

export function decisionReducer(state, action) {
  switch (action.type) {
    case "PARSE_STARTED":
      return { ...state, stage: "F1", status: "parsing", errorCode: null, selectedPlaceId: null };
    case "INTERPRETED":
      return {
        ...state,
        stage: action.payload.clarification.required ? "F2" : "F1",
        status: action.payload.clarification.required ? "clarifying" : "interpreted",
        request: action.payload.request,
        patch: action.payload.patch,
        changes: action.payload.changes,
        clarification: action.payload.clarification,
        versions: action.payload.versions,
      };
    case "CLARIFICATION_APPLIED":
      return { ...state, stage: "F3", status: "retrieving", request: action.request, clarification: null };
    case "DECISION_STARTED":
      return { ...state, stage: "F3", status: "retrieving", errorCode: null, selectedPlaceId: null };
    case "MANUAL_EDIT_APPLIED":
      return {
        ...state,
        request: action.request,
        changes: action.changedFields.map((field) => ({ field })),
        selectedPlaceId: null,
      };
    case "DECIDED":
      return {
        ...state,
        stage: action.payload.brief.status === "refused" ? "F7" : "F4",
        status: action.payload.brief.status,
        brief: action.payload.brief,
        context: action.payload.context,
        request: action.payload.brief.request,
        versions: action.payload.brief.versions,
        selectedPlaceId: null,
      };
    case "PLACE_SELECTED":
      return { ...state, stage: "F5", selectedPlaceId: action.placeId };
    case "PLACE_CLEARED":
      return { ...state, stage: state.brief?.status === "published" ? "F4" : state.stage, selectedPlaceId: null };
    case "CORRECTION_STARTED":
      return { ...state, stage: "F6", status: "correcting", errorCode: null, selectedPlaceId: null };
    case "CORRECTED":
      return {
        ...state,
        changes: action.payload.changes,
        request: action.payload.request,
        brief: action.payload.brief,
        context: action.payload.context,
        versions: action.payload.brief?.versions ?? action.payload.versions,
        stage: action.payload.brief?.status === "refused" ? "F7" : "F4",
        status: action.payload.brief?.status ?? "interpreted",
      };
    case "FAILED":
      return { ...state, stage: "F7", status: "failed", errorCode: action.errorCode, selectedPlaceId: null };
    case "RESET":
      return { ...initialDecisionState };
    default:
      return state;
  }
}
