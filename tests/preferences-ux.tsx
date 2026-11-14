import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App";
import { AppProvider, useStore } from "../src/store";
import { CONTENT_PREFERENCES_KEY, useContentPreferences } from "../src/contentPreferences";
import "../src/index.css";

const query = new URLSearchParams(location.search);
type Args = Record<string, unknown>;
const longTag = "L".repeat(64);
const tags = query.has("many") ? ["自然观察", ...Array.from({ length: 38 }, (_, i) => `标签 ${i + 1}`), longTag]
  : ["自然观察", " 自然观察 ", "Travel", "travel", "夜空"];
const card = (id: number) => ({ id, title: "城市与星光：一段很长但仍然清晰的测试标题", cover: "", description: "用于离线验证详情标签和屏蔽交互的中性测试内容。".repeat(5), tags, score: 8.5,
  hot: 1234, episode_count: 3, total_episodes: 3, is_finished: true, is_original: 0,
  author: { id: 7, name: "测试作者" }, counts: { like: 20, collect: 12, comment: 0, hot: 1234 },
  episodes: [1, 2, 3].map(ep_num => ({ ep_num, title: `第 ${ep_num} 集`, duration: 120, status: 1 })) });
let store: ReturnType<typeof useStore>;
let preferences: ReturnType<typeof useContentPreferences>;
const nativeSetItem = Storage.prototype.setItem;
const fixture = {
  ready: false, calls: [] as { command: string; args: Args }[], state: {} as Record<string, unknown>, tags, longTag,
  openFeed() { store.push({ kind: "feed", videoIds: [41], index: 0, title: "测试视频", startEp: 2, startTime: 17 }); },
  back() { store.pop(); },
  pause(value: boolean) { preferences.setPaused(value); },
  block(tags: string[]) { preferences.blockTags(tags); },
  fullscreen(value: boolean) { store.setFs(value); },
  storageFault(enabled: boolean) {
    Storage.prototype.setItem = enabled ? function (this: Storage, key: string, value: string) {
      if (key === CONTENT_PREFERENCES_KEY) throw new DOMException("Fixture storage full", "QuotaExceededError");
      return nativeSetItem.call(this, key, value);
    } : nativeSetItem;
  },
};
const empty = { items: [], pagination: { page: 1, pages: 1, total: 0, size: 20 } };
Object.assign(window, { preferencesUXFixture: fixture, __TAURI_INTERNALS__: {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback() { return 1; }, unregisterCallback() {},
  async invoke(command: string, args: Args = {}) {
    fixture.calls.push({ command, args });
    if (command === "app_boot") return { user: null, logged_in: false, base: "https://fixture.invalid", strict_security: true };
    if (command === "api_video") return card(Number(args.id));
    if (command === "api_play") return { id: args.id, ep_num: args.ep, duration: 120, video_url: `${location.origin}/fixture-video.mp4` };
    if (command === "api_feed" && query.has("home")) return { items: [card(41)], pagination: { page: 1, pages: 1, total: 1, size: 20 } };
    if (["api_feed", "api_related", "api_tag_videos", "api_comments"].includes(command)) return empty;
    if (command === "line_state") return { base: "https://fixture.invalid", fixed: [], custom: false };
    if (command === "proxy_state") return { mode: "system", url: "", effective: null };
    if (command === "playback_log_status") return { enabled: false, path: "", error: null };
    if (command === "plugin:window|is_maximized" || command === "plugin:window|is_fullscreen") return false;
    return null;
  },
} });
function Harness() {
  store = useStore(); preferences = useContentPreferences();
  fixture.ready = true;
  fixture.state = { stack: store.stack, history: store.history, preferences: preferences.preferences, storageError: preferences.storageError };
  return <App />;
}
createRoot(document.getElementById("root")!).render(<StrictMode><AppProvider><Harness /></AppProvider></StrictMode>);
