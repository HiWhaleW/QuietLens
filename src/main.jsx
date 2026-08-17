import React from "react";
import { createRoot } from "react-dom/client";
import { QuietLensDecisionApp as App } from "./ai-native/ui/QuietLensDecisionApp.jsx";
import "./styles.css";
import "./ai-native/ui/ai-native.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
