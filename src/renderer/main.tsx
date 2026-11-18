import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "../astryx-themes";
import "./app.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@astryxdesign/core/theme";
import { App } from "./App";
import { parnassusTheme } from "./theme";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element");

createRoot(rootElement).render(
  <StrictMode>
    <Theme theme={parnassusTheme} mode="dark">
      <App />
    </Theme>
  </StrictMode>,
);
