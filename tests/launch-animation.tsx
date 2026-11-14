import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import StartupGate, { LaunchAnimation } from "../src/components/LaunchAnimation";
import { acceptUsageAgreement } from "../src/usageAgreement";
import "../src/index.css";

const query = new URLSearchParams(location.search);
// This suite isolates launch motion. The dedicated disclaimer suite tests unsigned startup.
acceptUsageAgreement();
document.documentElement.classList.toggle("theme-light", query.get("theme") === "light");
const fixture = {
  ready: false,
  startedAt: performance.now(),
  childAt: 0,
  finishedAt: 0,
  finishes: 0,
  remount: () => {},
  setMounted: (_mounted: boolean) => {},
};
Object.assign(window, { launchAnimationFixture: fixture });

function Content() {
  useEffect(() => { fixture.childAt ||= performance.now(); }, []);
  return <main style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "var(--p-bg)", color: "var(--p-on)" }}>
    <button type="button" style={{ minHeight: 48, padding: "12px 24px", border: "1px solid currentColor", borderRadius: 24 }}>进入测试内容</button>
  </main>;
}

function Harness() {
  const [key, setKey] = useState(0);
  const [mounted, setMounted] = useState(true);
  const onFinish = useCallback(() => { fixture.finishes++; fixture.finishedAt = performance.now(); }, []);
  fixture.remount = () => setKey(previous => previous + 1);
  fixture.setMounted = setMounted;
  fixture.ready = true;
  return mounted ? query.has("preview") ? <LaunchAnimation key={key} onFinish={onFinish} />
    : <StartupGate key={key}><Content /></StartupGate> : null;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);
