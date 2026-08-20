import React, { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import {
  isLocalEvidenceReviewerAuthLocation,
  isLocalEvidenceReviewWorkbenchLocation,
} from "./ai-native/evidence/reviewWorkbenchEntry.js";
import "./styles.css";
import "./ai-native/ui/ai-native.css";
import "./ai-native/ui/beta-invite.css";
import "./ai-native/ui/evidence-review-workbench.css";
import { BetaInviteGate } from "./ai-native/ui/BetaInviteGate.jsx";

const DecisionApp = lazy(() => import("./ai-native/ui/QuietLensDecisionApp.jsx")
  .then((module) => ({ default: module.QuietLensDecisionApp })));
const EvidenceReviewApp = lazy(() => import("./ai-native/ui/EvidenceReviewWorkbenchApp.jsx")
  .then((module) => ({ default: module.EvidenceReviewWorkbenchApp })));
const EvidenceReviewerAuthApp = lazy(() => import("./ai-native/ui/EvidenceReviewerAuthSetupApp.jsx")
  .then((module) => ({ default: module.EvidenceReviewerAuthSetupApp })));
const DecisionBetaApp = () => <BetaInviteGate><DecisionApp /></BetaInviteGate>;
const RootApp = isLocalEvidenceReviewerAuthLocation(window.location)
  ? EvidenceReviewerAuthApp
  : isLocalEvidenceReviewWorkbenchLocation(window.location) ? EvidenceReviewApp : DecisionBetaApp;

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Suspense fallback={null}><RootApp /></Suspense>
  </React.StrictMode>,
);
