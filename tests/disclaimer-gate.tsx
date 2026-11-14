/** Install neutral offline native boundaries before importing the real application entry. */
export {};
const query = new URLSearchParams(location.search);
const agreementKey = query.get("agreementKey") || "hghubx_usage_agreement";
const nativeGetItem = Storage.prototype.getItem, nativeSetItem = Storage.prototype.setItem;
const callbacks = new Map<number, (value: unknown) => void>();
const backChannels = new Map<number, { id: number; onmessage: (value: unknown) => void }>();
let callbackId = 0;
const fixture = {
  ready: false,
  calls: [] as { command: string; args: Record<string, unknown> }[],
  storageFault(mode: "none" | "read" | "write" | "discard") {
    Storage.prototype.getItem = mode === "read" ? function (this: Storage, key: string) {
      if (key === agreementKey) throw new DOMException("Fixture read denied", "SecurityError");
      return nativeGetItem.call(this, key);
    } : nativeGetItem;
    Storage.prototype.setItem = mode === "write" || mode === "discard" ? function (this: Storage, key: string, value: string) {
      if (key === agreementKey) {
        if (mode === "write") throw new DOMException("Fixture storage full", "QuotaExceededError");
        return;
      }
      return nativeSetItem.call(this, key, value);
    } : nativeSetItem;
  },
  hardwareBack() { const channel = [...backChannels.values()].at(-1); if (!channel) throw new Error("No native back listener"); channel.onmessage({}); },
  hasHardwareBack: () => backChannels.size > 0,
};
document.documentElement.classList.toggle("theme-light", query.get("theme") !== "dark");
Object.assign(window, { disclaimerGateFixture: fixture, __TAURI_INTERNALS__: {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  transformCallback(callback: (value: unknown) => void) { const id = ++callbackId; callbacks.set(id, callback); return id; },
  unregisterCallback(id: number) { callbacks.delete(id); },
  async invoke(command: string, args: Record<string, unknown> = {}) {
    fixture.calls.push({ command, args });
    if (command === "app_boot") return { user: null, logged_in: false, base: "https://fixture.invalid", strict_security: true };
    if (command === "api_feed") return { items: [], pagination: { page: 1, pages: 1, total: 0, size: 30 } };
    if (command === "api_play") throw new Error("This fixture never supplies media");
    if (command === "line_auto") return { base: "https://fixture.invalid", previous: "https://fixture.invalid", switched: false, pick: { tier: "main", ms: 1, reason: "fixture", candidates: [] } };
    if (command === "playback_log_status") return { enabled: false, path: null, error: null };
    if (command === "plugin:app|register_listener" && args.event === "back-button") {
      const channel = args.handler as { id: number; onmessage: (value: unknown) => void }; backChannels.set(channel.id, channel); return;
    }
    if (command === "plugin:app|remove_listener") { backChannels.delete(Number(args.channelId)); return; }
    if (command === "plugin:window|is_maximized" || command === "plugin:window|is_fullscreen") return false;
    return null;
  },
} });
if (query.has("readFault")) fixture.storageFault("read");
void import("../src/main").then(() => { fixture.ready = true; });
