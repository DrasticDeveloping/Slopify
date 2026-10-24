import "@fontsource-variable/inter";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CloudAccount } from "./components/CloudAccount";
import "./styles/app.css";
import { startDesktopUpdates } from "./state/desktop";
import { startPwa } from "./state/pwa";
import { startLyricsSaver } from "./lyrics/useLyrics";

startPwa();
startDesktopUpdates();
startLyricsSaver();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CloudAccount>
      <App />
    </CloudAccount>
  </StrictMode>,
);
