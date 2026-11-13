import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { App } from "./App";
import { PRODUCT_NAME } from "../shared/brand";
import { bootstrapAppearance } from "./appearance/browser";
import { observeStartupPaint } from "./services/performanceDiagnostics";
import "./styles.css";

document.title = PRODUCT_NAME;

bootstrapAppearance();
observeStartupPaint();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);
