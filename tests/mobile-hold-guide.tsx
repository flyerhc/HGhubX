import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import Feed from "../src/components/Feed";
import { AppProvider, useStore } from "../src/store";
import { LOCAL } from "../src/api";
import { MOBILE_HOLD_GUIDE_KEY } from "../src/useMobileHoldGuide";
import { getHoldMenuBounds } from "../src/mobileHold";
import { runMobileHoldGeometryChecks } from "./mobile-hold";
import "../src/index.css";

const query = new URLSearchParams(location.search);
const ids = [41];
type Args = Record<string, unknown>;
const empty = { items: [], pagination: { page: 1, pages: 1, total: 0, size: 20 } };
const fixture = {
  ready: false, calls: [] as { command: string; args: Args }[], state: {} as Record<string, unknown>,
  key: MOBILE_HOLD_GUIDE_KEY, geometry: runMobileHoldGeometryChecks,
  setActive: (_active: boolean) => {}, setMounted: (_mounted: boolean) => {},
  fullscreen: (_fullscreen: boolean) => {},
  mediaReady() {
    const video = document.querySelector("video");
    if (!video) throw new Error("Expected video before setting media readiness");
    video.dispatchEvent(new Event("loadedmetadata"));
    video.dispatchEvent(new Event("loadeddata"));
  },
  menuBounds() {
    const target = document.querySelector("[data-mobile-hold-target]");
    if (!target) throw new Error("Expected mobile hold target");
    const rect = target.getBoundingClientRect();
    const menu = getHoldMenuBounds(rect.width, rect.height);
    return { left: rect.left + menu.left, top: rect.top + menu.top, width: menu.size, height: menu.size };
  },
};
Object.assign(window, { mobileHoldGuideFixture: fixture, __TAURI_INTERNALS__: {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback() { return 1; }, unregisterCallback() {},
  async invoke(command: string, args: Args = {}) {
    fixture.calls.push({ command, args });
    if (command === "app_boot") return { user: null, logged_in: false, base: "https://fixture.invalid", strict_security: true };
    if (command === "api_video") return {
      id: args.id, title: "山野与星光", cover: "", description: "中性的离线手势交互场景。", tags: ["自然", "星空"], score: 8,
      episode_count: 1, total_episodes: 1, is_finished: true, is_original: 0, author: { id: 7, name: "测试作者" },
      counts: { like: 20, collect: 12, comment: 0, hot: 1234 }, episodes: [{ ep_num: 1, title: "第 1 集", duration: 120, status: 1 }],
    };
    // Already-proxied /seg intentionally selects VideoSurface's native branch.
    if (command === "api_play") return { id: args.id, ep_num: args.ep, duration: 120,
      video_url: `${LOCAL}/seg?u=${encodeURIComponent("https://media.fixture.invalid/video.mp4")}` };
    if (["api_related", "api_comments", "api_feed"].includes(command)) return empty;
    if (command === "line_state") return { base: "https://fixture.invalid", fixed: [], custom: false };
    if (command === "playback_log_status") return { enabled: false, path: "", error: null };
    if (command === "proxy_state") return { mode: "system", url: "", effective: null };
    return null;
  },
} });

function Harness() {
  const store = useStore();
  const [active, setActive] = useState(!query.has("inactive"));
  const [mounted, setMounted] = useState(true);
  fixture.setActive = setActive; fixture.setMounted = setMounted; fixture.fullscreen = store.setFs;
  fixture.ready = true;
  fixture.state = { active, mounted, clean: store.clean, fs: store.fs };
  return <div className="absolute inset-0">
    <button id="focus-before-guide" style={{ position: "absolute", left: 8, top: 8, zIndex: 100 }} onClick={() => {}}>背景焦点</button>
    {mounted && <div className={`absolute inset-0 ${active ? "" : "hidden"}`}>
      <Feed videoIds={ids} mode="context" active={active} bottomInset={0} />
    </div>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><AppProvider><Harness /></AppProvider></StrictMode>);
