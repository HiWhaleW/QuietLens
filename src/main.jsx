import React, { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { isLocalEvidenceReviewWorkbenchLocation } from "./ai-native/evidence/reviewWorkbenchEntry.js";
import "./styles.css";
import "./ai-native/ui/ai-native.css";
import "./ai-native/ui/evidence-review-workbench.css";

const DecisionApp = lazy(() => import("./ai-native/ui/QuietLensDecisionApp.jsx")
  .then((module) => ({ default: module.QuietLensDecisionApp })));
const EvidenceReviewApp = lazy(() => import("./ai-native/ui/EvidenceReviewWorkbenchApp.jsx")
  .then((module) => ({ default: module.EvidenceReviewWorkbenchApp })));
const RootApp = isLocalEvidenceReviewWorkbenchLocation(window.location)
  ? EvidenceReviewApp
  : DecisionApp;

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Suspense fallback={null}><RootApp /></Suspense>
  </React.StrictMode>,
);
