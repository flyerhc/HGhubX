/* Keep a healthy current source. Switch only after confirmed failure, never to
 * reclaim a preferred hostname or shave a few milliseconds off a working line. */
import { api, hostOf, invalidateNetObservations, logLine, setNetObserver } from "./api";
import { tracePlayback } from "./playbackDiagnostics";
import { readStorage, STORAGE_KEYS } from "./storage";

const HEALTH_STEPS = [60_000, 120_000, 300_000];
const DOWN_STEPS = [30_000, 60_000, 120_000, 300_000];
const RECHECK_MS = 4_000;
const PICK_COOLDOWN_MS = 15_000;
let enabledOverride: boolean | null = null;
export const autoLineEnabled = (): boolean => enabledOverride ?? readStorage(STORAGE_KEYS.autoLine) !== "off";

let started = false, attached = false;
let epoch = 0;
let picking: number | null = null, checking: number | null = null;
let timer = 0, step = 0, downStep = 0, downStreak = 0, failStreak = 0;
let retryAt = 0;
let lastPickAt: number | null = null;
let cancellation: Promise<void> = Promise.resolve();
export let lastPick: { base: string; tier: string; ms: number } | null = null;

const runnable = () => autoLineEnabled() && navigator.onLine !== false && document.visibilityState === "visible";
const current = (token: number) => token === epoch && runnable();
function stopTimer() { window.clearTimeout(timer); timer = 0; }
function invalidate() {
  epoch++;
  picking = checking = null;
  downStreak = failStreak = step = downStep = retryAt = 0;
  lastPickAt = null;
  stopTimer();
  invalidateNetObservations();
}
function cancelPending(): Promise<void> {
  invalidate();
  const pending = cancellation.then(() => api.lineCancel());
  cancellation = pending.catch(error => { logLine(`[line] cancel failed: ${(error as Error).message}`); });
  return pending;
}
function schedule(delay: number) {
  stopTimer();
  if (!runnable()) return;
  const token = epoch;
  timer = window.setTimeout(() => { timer = 0; if (current(token)) void check("timer"); }, delay);
}
function backoff() {
  const delay = DOWN_STEPS[Math.min(downStep++, DOWN_STEPS.length - 1)];
  retryAt = Date.now() + delay;
  schedule(delay);
}

/** Restoring a failed manual selection's flag must not launch another selection. */
export const setAutoLine = (on: boolean, { select = true }: { select?: boolean } = {}): Promise<void> => {
  enabledOverride = on;
  try { localStorage.setItem(STORAGE_KEYS.autoLine, on ? "on" : "off"); } catch { /* memory preference remains active */ }
  const pending = on ? Promise.resolve() : cancelPending();
  if (on) {
    invalidate();
    if (started && !attached) attach();
    if (started) {
      if (select) void pickLine("enabled", true);
      else schedule(HEALTH_STEPS[0]);
    }
  }
  window.dispatchEvent(new Event("hg:auto-line-changed"));
  return pending;
};

export async function pickLine(reason: string, force = false): Promise<void> {
  if (!runnable() || picking !== null || checking !== null) return;
  if (Date.now() < retryAt) { schedule(retryAt - Date.now()); return; }
  if (!force && lastPickAt !== null && Date.now() - lastPickAt < PICK_COOLDOWN_MS) {
    schedule(PICK_COOLDOWN_MS - (Date.now() - lastPickAt)); return;
  }
  const token = epoch;
  picking = token;
  try {
    await cancellation;
    if (!current(token)) return;
    const result = await api.lineAuto();
    if (!current(token) || result.cancelled) return;
    lastPickAt = Date.now();
    downStreak = failStreak = step = 0;
    const candidates = result.pick.candidates.map(candidate => `${candidate.tier}:${candidate.ok ? "ok" : "down"}/${candidate.ms}ms`).join(",");
    if (result.pick.reason === "all-down") {
      logLine(`[line] auto(${reason}) all-down, keep ${hostOf(result.base)} | ${candidates}`);
      tracePlayback("line.allDown", { reason, line: hostOf(result.base), candidates });
      window.dispatchEvent(new Event("hg:line-down"));
      backoff();
      return;
    }
    downStep = retryAt = 0;
    lastPick = { base: result.base, tier: result.pick.tier, ms: result.pick.ms };
    logLine(`[line] auto(${reason}) ${hostOf(result.base)} reason=${result.pick.reason} switched=${result.switched} | ${candidates}`);
    tracePlayback("line.pick", { reason, line: hostOf(result.base), tier: result.pick.tier, ms: result.pick.ms, switched: result.switched, candidates });
    if (result.switched) {
      window.dispatchEvent(new CustomEvent("hg:line", {
        detail: { kind: result.pick.tier === "main" ? "main" : "mirror", host: hostOf(result.base), ms: result.pick.ms },
      }));
      window.dispatchEvent(new Event("hg:line-changed"));
    } else schedule(HEALTH_STEPS[0]);
  } catch (error) {
    if (!current(token)) return;
    logLine(`[line] auto(${reason}) failed: ${(error as Error).message}`);
    tracePlayback("line.fail", { where: "auto", reason, err: (error as Error).message });
    backoff();
  } finally {
    if (picking === token) picking = null;
  }
}

async function check(reason: string): Promise<void> {
  if (!runnable() || checking !== null || picking !== null) return;
  if (Date.now() < retryAt) { schedule(retryAt - Date.now()); return; }
  const token = epoch;
  checking = token;
  try {
    await cancellation;
    if (!current(token)) return;
    const health = await api.lineHealth();
    if (!current(token)) return;
    if (health.ok) {
      downStreak = failStreak = downStep = retryAt = 0;
      step = Math.min(step + 1, HEALTH_STEPS.length - 1);
      schedule(HEALTH_STEPS[step]);
      return;
    }
    downStreak++;
    logLine(`[line] health(${reason}) down=${downStreak} base=${hostOf(health.base)} ms=${health.ms}`);
    if (downStreak < 2) schedule(RECHECK_MS);
    else { downStreak = 0; step = 0; checking = null; await pickLine(reason, true); }
  } catch (error) {
    if (!current(token)) return;
    logLine(`[line] health(${reason}) failed: ${(error as Error).message}`);
    schedule(HEALTH_STEPS[step]);
  } finally {
    if (checking === token) checking = null;
  }
}

function attach() {
  if (attached) return;
  attached = true;
  setNetObserver(result => {
    if (!runnable() || !result.cmd.startsWith("api_")) return;
    if (result.ok) { failStreak = 0; return; }
    if (!result.networkish || ++failStreak < 2) return;
    failStreak = 0;
    void check("api-fail");
  });
  window.addEventListener("online", () => { if (runnable()) void check("online"); });
  window.addEventListener("offline", () => { void cancelPending().catch(() => {}); });
  window.addEventListener("hg:proxy-changed", () => {
    // The backend already invalidates selections when saving the proxy.
    invalidate();
    schedule(RECHECK_MS);
  });
  window.addEventListener("hg:line-changed", () => { invalidate(); schedule(HEALTH_STEPS[0]); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") void cancelPending().catch(() => {});
    else if (runnable()) void check("visible");
  });
}

export function initAutoLine(): void {
  if (started) return;
  started = true;
  attach();
  if (runnable()) void check("boot");
}
