import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useStore } from "../src/store";
import Settings from "../src/pages/Settings";
import { ToastHost } from "../src/components/ui";
import { autoLineEnabled, initAutoLine, pickLine, setAutoLine } from "../src/autoLine";
import { api } from "../src/api";
import "../src/index.css";

Object.assign(window, { lineSelectionControls: { autoLineEnabled, initAutoLine, pickLine, setAutoLine, api } });
initAutoLine();

function Probe() {
  const store = useStore();
  useEffect(() => {
    Object.assign(window, { lineSelectionSnapshot: { lineEpoch: store.lineEpoch, user: store.user, ready: store.strictSecurityReady } });
  }, [store]);
  return null;
}

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <Settings wide={innerWidth >= 900} onBack={() => {}} />
    <ToastHost />
    <Probe />
  </AppProvider>,
);
