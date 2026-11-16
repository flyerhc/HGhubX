import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "line-selection", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { environment: "Real Settings, LinePicker, store, api and autoLine; mocked Tauri IPC/clock; no upstream calls", passed: [], external: [] };
const MAIN = "https://main.fixture.invalid";
const MIRROR = "https://mirror-one.fixture.invalid";
const PUBLISHER = "https://publisher.fixture.invalid/";
const NEW_KEY = "hghubx_auto_line";
let vite, browser, page;
const errors = [];

try {
  vite = await createServer({ root, cacheDir: join(root, "node_modules/.vite-line-selection"), server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  let executablePath = process.env.BROWSER_EXECUTABLE;
  if (!executablePath) {
    for (const candidate of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
      if (await access(candidate).then(() => true, () => false)) { executablePath = candidate; break; }
    }
  }
  browser = await chromium.launch({ headless: true, executablePath });

  async function open(seed = { [NEW_KEY]: "on" }, options = {}) {
    const context = await browser.newContext({
      viewport: options.mobile ? { width: 390, height: 844 } : { width: 1280, height: 860 },
      ...(options.mobile ? { userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36" } : {}),
    });
    page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      if (new URL(route.request().url()).origin === new URL(origin).origin) return route.continue();
      report.external.push(route.request().url()); return route.abort();
    });
    await page.addInitScript(({ seed, options, MAIN, MIRROR, PUBLISHER }) => {
      if (!sessionStorage.getItem("line-fixture-seeded")) {
        localStorage.clear();
        for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
        sessionStorage.setItem("line-fixture-seeded", "1");
      }
      const fixture = {
        base: options.base || MIRROR, custom: !!options.custom, calls: [], lineChanged: 0, failSet: false,
        failMirrors: false, staleMirrors: false, healthy: options.healthy !== false, autoMode: "kept-current",
        generation: 0, holdAuto: false, autoFinished: 0, autoCancelled: 0, autoWaiters: [],
        holdHealth: false, healthFinished: 0, healthWaiters: [], feedQueue: [], feedWaiters: [],
        online: options.online !== false, visible: options.visible !== false,
        timers: new Map(), timerSequence: 100000, timeOffset: 0,
      };
      Object.defineProperty(navigator, "onLine", { configurable: true, get: () => fixture.online });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => fixture.visible ? "visible" : "hidden" });
      // Drive only long health/backoff timers and the API retry delay. React/UI clocks remain real.
      const setTimer = window.setTimeout.bind(window), clearTimer = window.clearTimeout.bind(window), now = Date.now.bind(Date);
      Date.now = () => now() + fixture.timeOffset;
      window.setTimeout = (callback, delay = 0, ...args) => {
        if (delay >= 4000 || delay === 1200) {
          const id = ++fixture.timerSequence;
          fixture.timers.set(id, { callback: () => callback(...args), due: Date.now() + delay, delay });
          return id;
        }
        return setTimer(callback, delay, ...args);
      };
      window.clearTimeout = id => { if (!fixture.timers.delete(id)) clearTimer(id); };
      fixture.advance = ms => {
        fixture.timeOffset += ms;
        const ready = [...fixture.timers].filter(([, timer]) => timer.due <= Date.now());
        for (const [id, timer] of ready) if (fixture.timers.delete(id)) timer.callback();
      };
      fixture.setVisible = visible => { fixture.visible = visible; document.dispatchEvent(new Event("visibilitychange")); };
      fixture.setOnline = online => { fixture.online = online; window.dispatchEvent(new Event(online ? "online" : "offline")); };
      window.addEventListener("hg:line-changed", () => fixture.lineChanged++);
      Object.assign(window, {
        isTauri: true, lineSelectionFixture: fixture,
        __TAURI_INTERNALS__: { async invoke(command, args = {}) {
          fixture.calls.push({ command, args });
          if (command === "app_boot") return { strict_security: true, base: fixture.base, user: null };
          if (command === "debug_log" || command === "playback_log_write") return;
          if (command === "playback_log_status") return { enabled: false, path: "fixture.log", error: null };
          if (command === "proxy_state") return { mode: "system", url: "", effective: null, system_proxy: false, env_proxy: false };
          if (command === "line_state") return { base: fixture.base, default: MAIN, custom: fixture.custom, fixed: [{ name: "主站", url: MAIN }] };
          if (command === "line_mirrors") {
            if (fixture.failMirrors) throw "fixture: publisher unavailable";
            return { source: PUBLISHER, cached: fixture.staleMirrors, stale: fixture.staleMirrors,
              errors: fixture.staleMirrors ? ["fixture: publisher unavailable"] : [], updated_at: Date.now(),
              recommended: [], items: [{ host: "mirror-one.fixture.invalid", url: MIRROR }] };
          }
          if (["line_set", "line_custom_set", "line_reset"].includes(command)) {
            fixture.generation++;
            if (fixture.failSet) throw "fixture: line rejected";
            fixture.base = command === "line_reset" ? MAIN : args.url;
            fixture.custom = command === "line_custom_set";
            return command === "line_set" ? fixture.base : { base: fixture.base, custom: fixture.custom };
          }
          if (command === "line_cancel") { fixture.generation++; return; }
          if (command === "line_probe") return args.urls.map(url => ({ url, ok: true, status: 200, ms: 42 }));
          if (command === "line_health") {
            const result = { base: fixture.base, ok: fixture.healthy, ms: 4, status: fixture.healthy ? 200 : null };
            if (fixture.holdHealth) await new Promise(resolve => fixture.healthWaiters.push(resolve));
            fixture.healthFinished++;
            return result;
          }
          if (command === "line_try_main") throw new Error("Healthy mirrors must not reclaim the main host");
          if (command === "line_auto") {
            const generation = ++fixture.generation, mode = fixture.autoMode;
            if (fixture.holdAuto) await new Promise(resolve => fixture.autoWaiters.push(resolve));
            const previous = fixture.base, cancelled = generation !== fixture.generation;
            fixture.autoFinished++;
            if (cancelled) {
              fixture.autoCancelled++;
              return { previous, base: previous, switched: false, cancelled: true, pick: { base: "", tier: "none", ms: 0, reason: "all-down", candidates: [] } };
            }
            if (mode === "all-down") return { previous, base: previous, switched: false, pick: { base: "", tier: "none", ms: 0, reason: mode, candidates: [] } };
            if (mode === "kept-current") return { previous, base: previous, switched: false, pick: { base: previous, tier: fixture.custom ? "custom" : "mirror", ms: 4, reason: mode, candidates: [] } };
            fixture.base = MAIN; fixture.custom = false;
            return { previous, base: MAIN, switched: previous !== MAIN, pick: { base: MAIN, tier: "main", ms: 34, reason: "main-ok", candidates: [] } };
          }
          if (command === "api_feed") {
            const mode = fixture.feedQueue.shift() || "ok";
            if (mode === "held-error") await new Promise(resolve => fixture.feedWaiters.push(resolve));
            if (mode === "error" || mode === "held-error") throw "connection timed out";
            return { items: [], pagination: { page: 1, pages: 1 } };
          }
          throw new Error(`Unexpected IPC: ${command}`);
        } },
      });
    }, { seed, options, MAIN, MIRROR, PUBLISHER });
    await page.goto(`${origin}tests/line-selection.html`);
    await page.waitForFunction(() => window.lineSelectionSnapshot?.ready);
    await page.getByRole("button", { name: "网络设置", exact: true }).click();
    return { context, page };
  }
  const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const count = (page, command) => page.evaluate(command => window.lineSelectionFixture.calls.filter(call => call.command === command).length, command);
  const sourceButton = page => page.getByRole("button").filter({ has: page.getByText("播放源", { exact: true }) });
  const toggle = page => page.getByRole("switch", { name: "自动选择线路", exact: true });
  const advance = async (page, ms) => { await page.evaluate(ms => window.lineSelectionFixture.advance(ms), ms); await settle(page); };
  const retry = async page => {
    await page.waitForFunction(() => [...window.lineSelectionFixture.timers.values()].some(timer => timer.delay === 1200));
    await advance(page, 1200);
  };
  const release = async (page, key) => { await page.evaluate(key => window.lineSelectionFixture[key].splice(0).forEach(resolve => resolve()), key); await settle(page); };
  const stable = page => page.evaluate(() => ({ base: window.lineSelectionFixture.base, changes: window.lineSelectionFixture.lineChanged, epoch: window.lineSelectionSnapshot.lineEpoch }));

  for (const seed of [{ "hg.autoLine": "off" }, { "hg.autoLine": "on", [NEW_KEY]: "off" }]) {
    const { context, page } = await open(seed);
    assert.equal(await page.evaluate(() => window.lineSelectionControls.autoLineEnabled()), false);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), NEW_KEY), "off");
    assert.equal(await page.evaluate(() => localStorage.getItem("hg.autoLine")), null);
    await page.evaluate(() => { window.dispatchEvent(new Event("online")); void window.lineSelectionControls.pickLine("disabled", true); });
    assert.equal(await count(page, "line_auto"), 0);
    assert.equal(await count(page, "line_health"), 0);
    report.passed.push("Legacy opt-out migrates and new preference wins without background selection");
    await context.close();
  }
  for (const custom of [false, true]) {
    const { context, page } = await open(undefined, { custom, base: custom ? "https://custom.fixture.invalid" : MIRROR });
    const before = await stable(page);
    assert.equal(await count(page, "line_health"), 1);
    await page.evaluate(() => window.dispatchEvent(new Event("online"))); await settle(page);
    await advance(page, 300000);
    await page.evaluate(() => window.lineSelectionControls.pickLine("explicit-current-check", true));
    assert.deepEqual(await stable(page), before);
    assert.equal(await count(page, "line_try_main"), 0);
    assert.equal(await count(page, "line_auto"), 1);
    report.passed.push(`${custom ? "Custom" : "Published mirror"}: boot/online/healthy checks keep current source; kept-current emits no change or account reset`);
    await context.close();
  }
  for (const mobile of [false, true]) {
    const { context, page } = await open({ [NEW_KEY]: "off" }, { mobile, base: MAIN });
    await sourceButton(page).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("mirror-one.fixture.invalid", { exact: true }).waitFor();
    assert.equal(await dialog.getByText("主站", { exact: true }).count(), 2);
    await dialog.getByText(`来源：${PUBLISHER}（地址发布页）`, { exact: false }).waitFor();
    assert.equal(await dialog.getByRole("button").filter({ hasText: PUBLISHER }).count(), 0);
    const row = dialog.getByRole("button").filter({ hasText: "mirror-one.fixture.invalid" });
    await page.evaluate(() => { window.lineSelectionFixture.failMirrors = true; });
    await dialog.getByRole("button", { name: "刷新", exact: true }).click();
    await dialog.getByText("镜像更新失败，已保留上次列表", { exact: true }).waitFor();
    await row.waitFor();
    await row.click();
    await page.waitForFunction(() => window.lineSelectionFixture.lineChanged === 1);
    assert.equal((await stable(page)).base, MIRROR);
    assert.equal(await page.evaluate(() => window.lineSelectionControls.autoLineEnabled()), false);
    report.passed.push(`${mobile ? "Mobile" : "Desktop"}: only one main source; publisher is metadata; refresh failure retains selectable cached mirrors; manual switch disables auto`);
    await context.close();
  }
  {
    const { context, page } = await open({ [NEW_KEY]: "off" });
    const before = await stable(page);
    await toggle(page).click();
    await page.waitForFunction(() => window.lineSelectionFixture.autoFinished === 1);
    assert.deepEqual(await stable(page), before);
    assert.equal(await toggle(page).getAttribute("aria-checked"), "true");
    assert.equal(await count(page, "line_try_main"), 0);
    report.passed.push("Enabling automatic selection checks but retains a healthy current source");
    await context.close();
  }
  {
    const { context, page } = await open();
    await page.evaluate(() => { window.lineSelectionFixture.staleMirrors = true; });
    await sourceButton(page).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("镜像更新失败，已保留上次列表", { exact: true }).waitFor();
    await dialog.getByText("上次保存的列表", { exact: false }).waitFor();
    await dialog.getByRole("button").filter({ hasText: MIRROR }).waitFor();
    report.passed.push("Backend stale discovery metadata is visible while cached mirror rows remain usable");
    await context.close();
  }
  {
    const { context, page } = await open();
    await sourceButton(page).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button").filter({ hasText: "主站" }).first().waitFor();
    await page.evaluate(() => { window.lineSelectionFixture.failSet = true; });
    const before = await stable(page), autoBefore = await count(page, "line_auto");
    await dialog.getByRole("button").filter({ hasText: MAIN }).click();
    await page.getByText("fixture: line rejected", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.lineSelectionControls.autoLineEnabled()), true);
    assert.equal(await count(page, "line_auto"), autoBefore);
    assert.deepEqual(await stable(page), before);
    report.passed.push("Failed manual choice restores auto preference without starting another selection or resetting current source");
    await context.close();
  }
  {
    const { context, page } = await open(undefined, { healthy: false });
    assert.equal(await count(page, "line_auto"), 0);
    await page.evaluate(() => { window.lineSelectionFixture.autoMode = "switch"; });
    await advance(page, 4000);
    await page.waitForFunction(() => window.lineSelectionFixture.lineChanged === 1);
    assert.equal(await count(page, "line_health"), 2);
    assert.equal(await count(page, "line_auto"), 1);
    assert.equal((await stable(page)).base, MAIN);
    report.passed.push("Two failed current-source health checks are required before automatic failover");
    await context.close();
  }
  {
    const { context, page } = await open();
    await page.evaluate(() => { window.lineSelectionFixture.healthy = false; window.lineSelectionFixture.autoMode = "all-down"; });
    const before = await stable(page);
    await page.evaluate(() => window.lineSelectionControls.pickLine("all-down", true));
    for (const [index, delay] of [30000, 60000, 120000, 300000].entries()) {
      const picks = await count(page, "line_auto");
      const scheduled = await page.evaluate(() => [...window.lineSelectionFixture.timers.values()].map(timer => timer.delay));
      assert.ok(scheduled.includes(delay), `all-down backoff ${delay}ms`);
      await page.evaluate(() => { window.dispatchEvent(new Event("online")); void window.lineSelectionControls.pickLine("too-soon", true); });
      assert.equal(await count(page, "line_auto"), picks);
      await advance(page, delay);
      await advance(page, 4000);
      assert.equal(await count(page, "line_auto"), index + 2);
    }
    assert.deepEqual(await stable(page), before);
    report.passed.push("All-down preserves current source and uses 30/60/120/300 second backoff that online/forced picks cannot bypass");
    await context.close();
  }
  for (const action of ["disable", "manual", "proxy", "hidden", "offline"]) {
    const { context, page } = await open();
    await page.evaluate(() => { window.lineSelectionFixture.holdHealth = true; window.lineSelectionFixture.healthy = false; window.dispatchEvent(new Event("online")); });
    await page.waitForFunction(() => window.lineSelectionFixture.healthWaiters.length === 1);
    if (action === "disable") await toggle(page).click();
    if (action === "manual") { await sourceButton(page).click(); await page.getByRole("dialog").getByRole("button").filter({ hasText: MAIN }).click(); }
    if (action === "proxy") await page.evaluate(() => { window.lineSelectionFixture.generation++; window.dispatchEvent(new Event("hg:proxy-changed")); });
    if (action === "hidden") await page.evaluate(() => window.lineSelectionFixture.setVisible(false));
    if (action === "offline") await page.evaluate(() => window.lineSelectionFixture.setOnline(false));
    await release(page, "healthWaiters");
    await page.evaluate(() => { window.lineSelectionFixture.holdHealth = false; window.lineSelectionFixture.healthy = true; });
    if (action === "proxy") await advance(page, 4000);
    else await advance(page, 300000);
    assert.equal(await count(page, "line_auto"), 0, `late health cannot select after ${action}`);
    if (action === "hidden" || action === "offline") {
      const checks = await count(page, "line_health");
      await page.evaluate(() => window.lineSelectionControls.pickLine("forced-inactive", true));
      assert.equal(await count(page, "line_health"), checks);
      assert.equal(await count(page, "line_auto"), 0);
    }
    report.passed.push(`A held health response is invalidated by ${action}; no stale retry or source mutation`);
    await context.close();
  }
  for (const action of ["disable", "hidden"]) {
    const { context, page } = await open({ [NEW_KEY]: "off" });
    await page.evaluate(() => { window.lineSelectionFixture.holdAuto = true; window.lineSelectionFixture.autoMode = "switch"; });
    await toggle(page).click();
    await page.waitForFunction(() => window.lineSelectionFixture.autoWaiters.length === 1);
    if (action === "disable") await toggle(page).click();
    else await page.evaluate(() => window.lineSelectionFixture.setVisible(false));
    await page.waitForFunction(() => window.lineSelectionFixture.calls.some(call => call.command === "line_cancel"));
    await release(page, "autoWaiters");
    assert.equal(await page.evaluate(() => window.lineSelectionFixture.autoCancelled), 1);
    assert.equal((await stable(page)).changes, 0);
    report.passed.push(`${action} cancels an in-flight backend selection before its late result can commit`);
    await context.close();
  }
  {
    const { context, page } = await open();
    const health = await count(page, "line_health");
    await page.evaluate(() => { window.lineSelectionFixture.feedQueue.push("error", "ok", "error", "ok"); window.feedResult = window.lineSelectionControls.api.feed().catch(() => null); });
    await retry(page); await page.evaluate(() => window.feedResult);
    await page.evaluate(() => { window.feedResult = window.lineSelectionControls.api.feed().catch(() => null); });
    await retry(page); await page.evaluate(() => window.feedResult);
    assert.equal(await count(page, "line_health"), health, "successful retries must not count as failures");
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => { window.lineSelectionFixture.feedQueue.push("error", "error"); window.feedResult = window.lineSelectionControls.api.feed().catch(() => null); });
      await retry(page); await page.evaluate(() => window.feedResult);
    }
    await settle(page);
    assert.equal(await count(page, "line_health"), health + 1, "only final network failures trigger health confirmation");
    report.passed.push("API observer ignores transient failures that retry successfully and counts only final failures");
    await context.close();
  }
  {
    const { context, page } = await open();
    await page.evaluate(() => {
      window.lineSelectionFixture.feedQueue.push("held-error", "held-error");
      window.staleFeeds = Promise.all([window.lineSelectionControls.api.feed().catch(() => null), window.lineSelectionControls.api.feed().catch(() => null)]);
    });
    await page.waitForFunction(() => window.lineSelectionFixture.feedWaiters.length === 2);
    await page.evaluate(() => { window.lineSelectionFixture.base = "https://next.fixture.invalid"; window.dispatchEvent(new Event("hg:line-changed")); });
    const checks = await count(page, "line_health");
    await release(page, "feedWaiters"); await retry(page); await page.evaluate(() => window.staleFeeds);
    assert.equal(await count(page, "api_feed"), 2, "old source failures must not retry against the new source");
    assert.equal(await count(page, "line_health"), checks, "old failures must not mark new source unhealthy");
    report.passed.push("Requests from an old source epoch cannot retry or influence new-source health");
    await context.close();
  }
  {
    const { context, page } = await open(undefined, { visible: false, online: false });
    assert.equal(await count(page, "line_health"), 0);
    assert.equal(await count(page, "line_auto"), 0);
    await page.evaluate(() => { window.lineSelectionFixture.setOnline(true); });
    assert.equal(await count(page, "line_health"), 0);
    await page.evaluate(() => window.lineSelectionFixture.setVisible(true)); await settle(page);
    assert.equal(await count(page, "line_health"), 1);
    report.passed.push("Hidden/offline boot does no network checks; returning visible and online checks current source");
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(report.external, []);
  console.log(`PASS line-selection: ${report.passed.length} cases`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = String(error.stack || error);
  await page?.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  console.error(report.error); process.exitCode = 1;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser?.close(); await vite?.close();
  console.log(`Artifacts: ${output}`);
}
