import "@fontsource-variable/inter";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CloudAccount } from "./components/CloudAccount";
import "./styles/app.css";
import { startDesktopUpdates } from "./state/desktop";
import { startStreaming } from "./state/importer";
import { startPwa } from "./state/pwa";

startStreaming();
startPwa();
startDesktopUpdates();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CloudAccount>
      <App />
    </CloudAccount>
  </StrictMode>,
);
