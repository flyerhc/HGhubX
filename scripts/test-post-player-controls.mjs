/** Real Player with mocked media/fullscreen APIs; does not prove native device playback. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = fileURLToPath(new URL(`../test-results/post-player-controls/${Date.now()}/`, import.meta.url));
const report = { environment: "Real Player; media and fullscreen are mocked, no native playback assertion", passed: [], failed: [], errors: [] };
const controls = page => page.locator(".player-inline-controls");
const player = page => page.locator(".post-player");
const enter = page => page.getByRole("button", { name: "全屏", exact: true });
const exit = page => page.getByRole("button", { name: "退出全屏", exact: true });
const waitOpacity = (page, visible) => page.waitForFunction(visible => {
  const element = document.querySelector(".player-inline-controls");
  return element && (visible ? Number(getComputedStyle(element).opacity) > .99 : Number(getComputedStyle(element).opacity) < .01);
}, visible);
const assertTouchTargets = async page => {
  const targets = await controls(page).getByRole("button").evaluateAll(buttons => buttons.map(button => {
    const r = button.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { name: button.getAttribute("aria-label") || button.textContent, width: r.width, height: r.height,
      inViewport: r.left >= -.5 && r.top >= -.5 && r.right <= innerWidth + .5 && r.bottom <= innerHeight + .5,
      reachable: top === button || button.contains(top) };
  }));
  assert(targets.length >= 5, "Play, mute, lock, rate and fullscreen actions remain available");
  for (const target of targets) {
    assert(target.width >= 43.9 && target.height >= 43.9, `${target.name}: at least 44px touch target`);
    assert(target.inViewport && target.reachable, `${target.name}: visible and not covered`);
  }
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No page horizontal overflow");
  assert(await player(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1), "No player horizontal overflow");
};
let browser, server;
try {
  await mkdir(out, { recursive: true });
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const run = async (name, body, { width = 375, height = 812, desktop = false, fullscreen = "native" } = {}) => {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce",
      ...(!desktop ? { userAgent: "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36", isMobile: true, hasTouch: true } : {}) });
    await context.addInitScript(({ fullscreen }) => {
      localStorage.clear();
      Object.defineProperty(window, "MediaSource", { configurable: true, value: undefined });
      Object.defineProperty(window, "ManagedMediaSource", { configurable: true, value: undefined });
      const paused = new WeakMap();
      const source = new WeakMap();
      window.postControlsMedia = { play: 0, pause: 0, fullscreen: 0, exitFullscreen: 0, rejectFullscreen: null };
      Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get() { return paused.get(this) ?? true; } });
      Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get() { return 2; } });
      Object.defineProperty(HTMLMediaElement.prototype, "duration", { configurable: true, get() { return 7322; } });
      Object.defineProperty(HTMLMediaElement.prototype, "src", { configurable: true, get() { return source.get(this) || ""; }, set(value) { source.set(this, value); } });
      HTMLMediaElement.prototype.load = function () {};
      HTMLMediaElement.prototype.play = function () {
        window.postControlsMedia.play++;
        paused.set(this, false);
        this.dispatchEvent(new Event("play")); this.dispatchEvent(new Event("playing"));
        return Promise.resolve();
      };
      HTMLMediaElement.prototype.pause = function () {
        window.postControlsMedia.pause++;
        const wasPlaying = paused.get(this) === false;
        paused.set(this, true);
        if (wasPlaying) this.dispatchEvent(new Event("pause"));
      };
      let owner = null;
      Object.defineProperty(document, "fullscreenElement", { configurable: true, get() { return owner; } });
      Object.defineProperty(Element.prototype, "requestFullscreen", { configurable: true, value: fullscreen === "absent" ? undefined : function () {
        window.postControlsMedia.fullscreen++;
        if (fullscreen === "delayed-reject") return new Promise((_resolve, reject) => { window.postControlsMedia.rejectFullscreen = () => reject(new DOMException("Fixture late failure", "NotAllowedError")); });
        if (fullscreen === "reject") return Promise.reject(new DOMException("Fixture unavailable", "NotAllowedError"));
        owner = this; document.dispatchEvent(new Event("fullscreenchange")); return Promise.resolve();
      } });
      document.exitFullscreen = async function () { window.postControlsMedia.exitFullscreen++; owner = null; document.dispatchEvent(new Event("fullscreenchange")); };
    }, { fullscreen });
    const page = await context.newPage(); page.setDefaultTimeout(6500);
    page.on("pageerror", error => report.errors.push({ name, message: error.message }));
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
    try {
      await page.goto(`${origin}tests/post-player-controls.html`);
      await page.waitForFunction(() => window.postControlsFixture?.ready);
      await player(page).waitFor();
      await page.evaluate(() => window.postControlsFixture.mediaReady());
      await page.waitForFunction(() => !document.querySelector("video").paused);
      await body(page);
      await page.screenshot({ path: `${out}/${name}.png`, animations: "disabled" });
      report.passed.push(name); console.log(`PASS ${name}`);
    } catch (error) {
      report.failed.push({ name, error: String(error.stack || error) });
      await page.screenshot({ path: `${out}/${name}-failure.png`, animations: "disabled" }).catch(() => {});
      console.error(`FAIL ${name}: ${error.message}`);
    } finally { await context.close(); }
  };

  for (const viewport of [{ width: 320, height: 568 }, { width: 375, height: 812 }, { width: 844, height: 390 }]) {
    await run(`touch-controls-${viewport.width}`, async page => {
      assert(await page.evaluate(() => matchMedia("(pointer: coarse)").matches && matchMedia("(hover: none)").matches));
      await page.mouse.move(0, 0); await waitOpacity(page, true); await assertTouchTargets(page);
      await controls(page).getByRole("button", { name: "暂停", exact: true }).tap();
      await page.waitForFunction(() => document.querySelector("video").paused);
      await controls(page).getByRole("button", { name: "播放", exact: true }).tap();
      await page.waitForFunction(() => !document.querySelector("video").paused);
      await controls(page).getByRole("button", { name: "静音", exact: true }).tap();
      await page.waitForFunction(() => document.querySelector("video").muted);
      await controls(page).getByRole("button", { name: "锁定播放控制", exact: true }).tap();
      await page.locator("[data-playback-lock-shield]").waitFor();
      assert(await controls(page).evaluate(el => !!el.closest("[inert]")), "Locked media controls are inert");
      await page.getByRole("button", { name: "解锁播放控制", exact: true }).tap();
      await page.locator("[data-playback-lock-shield]").waitFor({ state: "detached" });
      await assertTouchTargets(page);
      await enter(page).tap(); await exit(page).waitFor();
      assert(await page.evaluate(() => document.fullscreenElement === document.querySelector(".post-player")));
      await exit(page).tap(); await enter(page).waitFor();
      assert.equal(await page.evaluate(() => document.fullscreenElement), null);
    }, viewport);
  }

  await run("desktop-hover-focus-and-paused", async page => {
    await page.mouse.move(0, 0); await page.locator("#outside-player").focus(); await waitOpacity(page, false);
    await player(page).hover(); await waitOpacity(page, true);
    await page.mouse.move(0, 0); await waitOpacity(page, false);
    await enter(page).focus(); await waitOpacity(page, true);
    assert(await enter(page).evaluate(el => el === document.activeElement));
    await page.locator("#outside-player").focus(); await waitOpacity(page, false);
    await page.evaluate(() => document.querySelector("video").pause()); await waitOpacity(page, true);
  }, { desktop: true, width: 1280, height: 850 });

  await run("controls-disabled", async page => {
    await page.evaluate(() => window.postControlsFixture.setControls(false));
    await controls(page).waitFor({ state: "detached" });
    assert.equal(await enter(page).count(), 0);
  });

  for (const fullscreen of ["absent", "reject"]) {
    await run(`fullscreen-fallback-${fullscreen}`, async page => {
      await page.evaluate(() => {
        const video = document.querySelector("video");
        window.originalPostVideo = video;
        video.currentTime = 3661;
        video.playbackRate = 1.5;
      });
      await enter(page).tap(); await exit(page).waitFor();
      assert.equal(await page.evaluate(() => document.fullscreenElement), null);
      await page.waitForFunction(() => {
        const r = document.querySelector(".post-player").getBoundingClientRect();
        return Math.abs(r.left) < 1 && Math.abs(r.top) < 1 && Math.abs(r.width - innerWidth) < 2 && Math.abs(r.height - innerHeight) < 2;
      });
      assert(await page.evaluate(() => document.querySelector("video") === window.originalPostVideo), "Fullscreen retains the original video node");
      assert.equal(await page.locator("video").evaluate(el => el.currentTime), 3661);
      assert.equal(await page.locator("video").evaluate(el => el.playbackRate), 1.5);
      await assertTouchTargets(page);
      await exit(page).tap(); await enter(page).waitFor();
      assert(await player(page).evaluate(el => el.getBoundingClientRect().height < innerHeight - 1));
      await enter(page).tap(); await exit(page).waitFor();
      await page.keyboard.press("Escape"); await enter(page).waitFor();
      assert(await player(page).evaluate(el => el.getBoundingClientRect().height < innerHeight - 1));
      assert(await page.evaluate(() => document.querySelector("video") === window.originalPostVideo), "Exit retains playback instance");
      await enter(page).tap(); await exit(page).waitFor();
      assert(await page.evaluate(() => window.postControlsFixture.back()), "System back is consumed by fullscreen");
      await enter(page).waitFor();
      assert(await player(page).evaluate(el => el.getBoundingClientRect().height < innerHeight - 1));
      await enter(page).tap(); await exit(page).waitFor();
      await page.evaluate(() => window.postControlsFixture.setActive(false));
      await page.waitForFunction(() => document.querySelector(".post-player")?.dataset.fullscreen === "false");
      assert.equal(await page.locator("video").evaluate(el => el.paused), true, "Leaving the page pauses the fullscreen player");
      assert(await player(page).evaluate(el => el.getBoundingClientRect().height < innerHeight - 1));
    }, { fullscreen });
  }

  await run("late-fullscreen-rejection-after-inactive", async page => {
    await enter(page).tap();
    await page.waitForFunction(() => typeof window.postControlsMedia.rejectFullscreen === "function");
    await page.evaluate(() => window.postControlsFixture.setActive(false));
    await page.waitForFunction(() => document.querySelector("video").paused);
    await page.evaluate(async () => {
      window.postControlsMedia.rejectFullscreen();
      await Promise.resolve(); await Promise.resolve();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.equal(await player(page).getAttribute("data-fullscreen-fallback"), "false");
    assert.equal(await exit(page).count(), 0, "Late rejected request does not reopen an inactive player");
    assert(await player(page).evaluate(el => el.getBoundingClientRect().height < innerHeight - 1));
  }, { fullscreen: "delayed-reject" });

  await run("late-fullscreen-rejection-after-unmount", async page => {
    await enter(page).tap();
    await page.waitForFunction(() => typeof window.postControlsMedia.rejectFullscreen === "function");
    await page.evaluate(() => window.postControlsFixture.setMounted(false));
    await player(page).waitFor({ state: "detached" });
    await page.evaluate(async () => {
      window.postControlsMedia.rejectFullscreen();
      await Promise.resolve(); await Promise.resolve();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.equal(await player(page).count(), 0, "Late rejected request does not remount the player host");
    assert.equal(await page.evaluate(() => window.postControlsFixture.back()), false, "Unmount removes fullscreen back handler");
  }, { fullscreen: "delayed-reject" });

  assert.equal(report.failed.length, 0, "All post player control cases pass");
  assert.equal(report.errors.length, 0, "No browser errors");
} catch (error) {
  report.failed.push({ name: "suite", error: String(error.stack || error) }); process.exitCode = 1;
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  await browser?.close(); await server?.close();
  console.log(`Post player controls: ${report.passed.length} passed; ${report.failed.length} failed. ${out}/report.json`);
}
