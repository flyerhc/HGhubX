/** Real Feed + isolated IPC/media mocks; never asserts native-device playback. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = fileURLToPath(new URL(`../test-results/mobile-hold-guide/${Date.now()}/`, import.meta.url));
const key = (await readFile(`${root}src/useMobileHoldGuide.ts`, "utf8")).match(/MOBILE_HOLD_GUIDE_KEY\s*=\s*"([^"]+)"/)[1];
const report = { environment: "Real Feed with neutral mocked IPC and media events; no native playback claim", passed: [], failed: [], errors: [] };
const guide = page => page.getByRole("dialog", { name: "视频长按操作提示", exact: true });
const menu = page => page.getByRole("dialog", { name: "不感兴趣", exact: true });
const ready = async page => {
  await page.locator("video").waitFor();
  await page.evaluate(() => window.mobileHoldGuideFixture.mediaReady());
};
const box = locator => locator.evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
const hold = async (page, x, y) => { await page.mouse.move(x, y); await page.mouse.down(); await page.waitForTimeout(430); };
let browser, server;
try {
  await mkdir(out, { recursive: true });
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } }); await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const run = async (name, body, { width = 375, height = 812, desktop = false, query = "", seen = false } = {}) => {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce",
      ...(!desktop ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", isMobile: true, hasTouch: true } : {}) });
    await context.addInitScript(({ key, seen }) => {
      if (!sessionStorage.getItem("hold-fixture-seeded")) {
        localStorage.clear(); localStorage.setItem("hghubx_auto_line", "off");
        if (seen) localStorage.setItem(key, "1");
        sessionStorage.setItem("hold-fixture-seeded", "1");
      }
      const paused = new WeakMap();
      window.fakeHoldMedia = { play: 0, pause: 0 };
      Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get() { return paused.get(this) ?? true; } });
      Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get() { return 2; } });
      Object.defineProperty(HTMLMediaElement.prototype, "duration", { configurable: true, get() { return 120; } });
      Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get() { return 720; } });
      Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get() { return 1280; } });
      const src = new WeakMap();
      Object.defineProperty(HTMLMediaElement.prototype, "src", { configurable: true, get() { return src.get(this) || ""; }, set(value) { src.set(this, value); } });
      HTMLMediaElement.prototype.play = function () { window.fakeHoldMedia.play++; paused.set(this, false); this.dispatchEvent(new Event("play")); this.dispatchEvent(new Event("playing")); return Promise.resolve(); };
      HTMLMediaElement.prototype.pause = function () { window.fakeHoldMedia.pause++; const playing = paused.get(this) === false; paused.set(this, true); if (playing) this.dispatchEvent(new Event("pause")); };
      HTMLMediaElement.prototype.load = function () {};
    }, { key, seen });
    const page = await context.newPage(); page.setDefaultTimeout(6500);
    page.on("pageerror", error => report.errors.push({ name, message: error.message }));
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
    try {
      await page.goto(`${origin}tests/mobile-hold-guide.html${query}`);
      await page.waitForFunction(() => window.mobileHoldGuideFixture?.ready);
      await body(page, { width, height });
      await page.screenshot({ path: `${out}/${name}.png`, animations: "disabled" });
      report.passed.push(name); console.log(`PASS ${name}`);
    } catch (error) {
      report.failed.push({ name, error: String(error.stack || error) });
      await page.screenshot({ path: `${out}/${name}-failure.png`, animations: "disabled" }).catch(() => {});
      console.error(`FAIL ${name}: ${error.message}`);
    } finally { await context.close(); }
  };

  await run("first-ready-focus-and-no-pointer-through", async page => {
    await page.locator("video").waitFor();
    assert.equal(await guide(page).count(), 0, "A media URL alone does not show the guide");
    await page.locator("#focus-before-guide").focus(); await ready(page); await guide(page).waitFor();
    assert.equal(await page.locator("video").evaluate(el => el.paused), true, "Playback pauses behind the guide");
    assert(await page.getByRole("button", { name: "知道了", exact: true }).evaluate(el => el === document.activeElement));
    await page.keyboard.press("Tab");
    assert(await guide(page).evaluate(el => el.contains(document.activeElement)), "Focus remains in the guide");
    const r = await box(page.locator("[data-hold-guide-menu]"));
    await hold(page, r.left + r.width / 2, r.top + r.height / 2); await page.mouse.up();
    assert.equal(await menu(page).count(), 0, "Long-press cannot reach the player through the guide");
    assert.equal(await page.locator("video").evaluate(el => el.playbackRate), 1);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null, "Showing is not acknowledgement");
    await page.keyboard.press("Escape"); await guide(page).waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), "1");
    assert(await page.locator("#focus-before-guide").evaluate(el => el === document.activeElement));
  });

  await run("confirm-persists-across-remount-and-reload", async page => {
    await ready(page); await guide(page).getByRole("button", { name: "知道了", exact: true }).click();
    await guide(page).waitFor({ state: "hidden" });
    await page.evaluate(() => window.mobileHoldGuideFixture.setMounted(false)); await page.locator("video").waitFor({ state: "detached" });
    await page.evaluate(() => window.mobileHoldGuideFixture.setMounted(true)); await ready(page);
    assert.equal(await guide(page).count(), 0);
    await page.reload(); await page.waitForFunction(() => window.mobileHoldGuideFixture?.ready); await ready(page);
    assert.equal(await guide(page).count(), 0);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), "1");
  });

  await run("inactive-does-not-consume-first-visit", async page => {
    assert.equal(await guide(page).count(), 0);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
    await page.evaluate(() => window.mobileHoldGuideFixture.setActive(true)); await ready(page); await guide(page).waitFor();
    await page.evaluate(() => window.mobileHoldGuideFixture.setActive(false)); await guide(page).waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null, "Leaving without acknowledging does not persist");
    await page.evaluate(() => window.mobileHoldGuideFixture.setActive(true)); await guide(page).waitFor();
  }, { query: "?inactive=1" });

  await run("desktop-does-not-show-or-consume-guide", async page => {
    await ready(page);
    assert.equal(await guide(page).count(), 0);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
  }, { desktop: true, width: 1280, height: 900 });

  await run("storage-failure-keeps-session-acknowledgement", async page => {
    await ready(page); await guide(page).waitFor();
    await page.evaluate(key => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        if (name === key) throw new DOMException("Fixture storage full", "QuotaExceededError");
        return original.call(this, name, value);
      };
    }, key);
    await guide(page).getByRole("button", { name: "知道了", exact: true }).click(); await guide(page).waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null, "Failed write is not presented as persistence");
    await page.evaluate(() => window.mobileHoldGuideFixture.setMounted(false)); await page.locator("video").waitFor({ state: "detached" });
    await page.evaluate(() => window.mobileHoldGuideFixture.setMounted(true)); await ready(page);
    assert.equal(await guide(page).count(), 0, "In-memory acknowledgement survives player remount in this session");
  });

  await run("center-menu-and-outer-speed-restore", async page => {
    await ready(page); const target = page.locator("[data-mobile-hold-target]");
    let r = await box(target);
    await hold(page, r.left + r.width * .74, r.top + r.height * .25);
    assert.equal(await page.locator("video").evaluate(el => el.playbackRate), 2);
    await page.mouse.up(); await page.waitForFunction(() => document.querySelector("video").playbackRate === 1);
    await hold(page, r.left + r.width * .25, r.top + r.height * .64);
    assert.equal(await page.locator("video").evaluate(el => el.playbackRate), .5);
    await page.mouse.up(); await page.waitForFunction(() => document.querySelector("video").playbackRate === 1);
    r = await box(target); await hold(page, r.left + r.width / 2, r.top + r.height / 2); await page.mouse.up();
    await menu(page).waitFor(); assert.equal(await page.locator("video").evaluate(el => el.playbackRate), 1);
  }, { seen: true });

  for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await run(`square-geometry-${viewport.width}`, async (page, { width, height }) => {
      await ready(page); await guide(page).waitFor(); await page.locator("[data-mobile-hold-guide][data-ready=true]").waitFor();
      await page.evaluate(() => window.mobileHoldGuideFixture.geometry());
      const actual = await box(page.locator("[data-hold-guide-menu]"));
      const expected = await page.evaluate(() => window.mobileHoldGuideFixture.menuBounds());
      for (const part of ["left", "top", "width", "height"]) assert(Math.abs(actual[part] - expected[part]) < 1, `${part} matches the actual gesture target`);
      assert(Math.abs(actual.width - actual.height) < .1, "Menu region stays square");
      const done = page.getByRole("button", { name: "知道了", exact: true }); const action = await box(done);
      assert(action.height >= 44 && action.left >= 0 && action.top >= 0 && action.left + action.width <= width + 1 && action.top + action.height <= height + 1);
      assert(await done.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }, viewport);
  }
  assert.equal(report.failed.length, 0, "All mobile guide cases pass");
  assert.equal(report.errors.length, 0, "No browser errors");
} catch (error) {
  report.failed.push({ name: "suite", error: String(error.stack || error) }); process.exitCode = 1;
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  await browser?.close(); await server?.close();
  console.log(`Mobile hold guide: ${report.passed.length} passed; ${report.failed.length} failed. ${out}/report.json`);
}
