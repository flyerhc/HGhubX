/** Pure-code launch animation: real component + StrictMode, no network/native media. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { installFixture } from "./fixtures/app-ui.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(new URL(`../test-results/launch-animation/${Date.now()}/`, import.meta.url));
await mkdir(output, { recursive: true });
const agreementSource = await readFile(`${root}src/usageAgreement.ts`, "utf8");
const agreementKey = agreementSource.match(/USAGE_AGREEMENT_KEY\s*=\s*"([^"]+)"/)[1];
const agreementVersion = agreementSource.match(/USAGE_AGREEMENT_VERSION\s*=\s*"([^"]+)"/)[1];
const report = { environment: "Real LaunchAnimation/StartupGate in StrictMode Chromium; deterministic JS clock; no external requests or native-device claim", passed: [], failed: [], errors: [], measurements: [] };
let server, browser;
const dialog = p => p.getByRole("dialog", { name: "HGhubX 启动动画", exact: true });
const child = p => p.getByRole("button", { name: "进入测试内容", exact: true });
const paint = p => p.clock.runFor(32);
try {
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const run = async (name, body, { width = 375, height = 812, theme = "dark", reducedMotion = "no-preference", query = "", realApp = false } = {}) => {
    if (process.env.LAUNCH_CASE && process.env.LAUNCH_CASE !== name) return;
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion,
      ...(width < 900 ? { isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" } : {}) });
    const page = await context.newPage();
    page.setDefaultTimeout(4500);
    page.on("pageerror", e => report.errors.push({ name, message: e.message }));
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
    if (realApp) {
      await context.addInitScript(installFixture, { theme, titles: ["测试故事", "城市纪录"] });
      await context.addInitScript(({ agreementKey, agreementVersion }) => {
        localStorage.setItem(agreementKey, JSON.stringify({ version: agreementVersion, accepted: true, acceptedAt: new Date().toISOString() }));
        localStorage.setItem("hghubx_auto_line", "off");
        window.launchAppCalls = [];
        const original = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = (command, args) => {
          window.launchAppCalls.push(command);
          // A slow boot/account restore must neither delay dismissal nor start media behind it.
          if (command === "app_boot") return new Promise(() => {});
          return original(command, args);
        };
      }, { agreementKey, agreementVersion });
    }
    await page.clock.install();
    try {
      await page.goto(realApp ? origin : `${origin}tests/launch-animation.html?theme=${theme}&${query}`);
      if (!realApp) await page.waitForFunction(() => window.launchAnimationFixture?.ready);
      await body(page);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No horizontal overflow");
      report.passed.push(name);
      console.log(`PASS ${name}`);
    } catch (error) {
      report.failed.push({ name, error: String(error.stack || error) });
      console.error(`FAIL ${name}: ${error.message}`);
      await page.screenshot({ path: `${output}/${name}-failure.png` }).catch(() => {});
    } finally { await context.close(); }
  };

  for (const [width, height] of [[375, 812], [320, 694], [844, 390], [1280, 800]]) for (const theme of ["light", "dark"]) {
    const name = `layout-${width}x${height}-${theme}`;
    await run(name, async page => {
      await dialog(page).waitFor();
      assert.equal(await child(page).count(), 0, "Application/media children are not mounted during launch");
      assert.equal(await dialog(page).locator("svg").count(), 1, "Logo is a single code-rendered SVG");
      assert.equal(await dialog(page).locator("img, video, canvas").count(), 0, "No bitmap, video or canvas dependency");
      const button = page.getByRole("button", { name: "跳过启动动画", exact: true });
      const bounds = await button.boundingBox();
      assert(bounds.width >= 44 && bounds.height >= 44, "Skip has a minimum 44px touch target");
      assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1, "Skip fits viewport/safe area");
      const geometry = await dialog(page).locator("svg").boundingBox();
      assert(geometry.x >= 0 && geometry.y >= 0 && geometry.x + geometry.width <= width + 1 && geometry.y + geometry.height <= height + 1, "Logo fits viewport");
      report.measurements.push({ name, button: bounds, logo: geometry });
      // Pause CSS at a composited mid-pose; JS completion timer remains separately controlled.
      await page.evaluate(() => { for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = 900; } });
      await page.screenshot({ path: `${output}/${name}.png` });
      await page.clock.runFor(2600);
      await child(page).waitFor();
      assert.equal(await dialog(page).count(), 0, "Automatic completion removes blocking overlay");
      await page.evaluate(() => window.launchAnimationFixture.remount());
      await paint(page);
      await child(page).waitFor();
      assert.equal(await dialog(page).count(), 0, "Remount in same runtime does not replay launch");
    }, { width, height, theme });
  }

  await run("skip-button-and-escape", async page => {
    await dialog(page).waitFor();
    await page.getByRole("button", { name: "跳过启动动画", exact: true }).click();
    await paint(page);
    await child(page).waitFor();
    assert.equal(await dialog(page).count(), 0);
    // A reload is a new application runtime and should show the intro again.
    await page.reload();
    await dialog(page).waitFor();
    await page.keyboard.press("Escape");
    await paint(page);
    await child(page).waitFor();
    assert.equal(await dialog(page).count(), 0);
  });

  await run("background-finishes-without-delayed-replay", async page => {
    await dialog(page).waitFor();
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
    await paint(page);
    await child(page).waitFor();
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); window.launchAnimationFixture.remount(); });
    await paint(page);
    assert.equal(await dialog(page).count(), 0);
  });

  await run("reduced-motion-static-under-250ms", async page => {
    await page.clock.runFor(250);
    await child(page).waitFor();
    assert.equal(await dialog(page).count(), 0);
    const active = await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === "running").length);
    assert.equal(active, 0, "No remaining launch motion");
  }, { reducedMotion: "reduce", width: 320, height: 694, theme: "light" });

  await run("motion-preference-change-finishes-immediately", async page => {
    await dialog(page).waitFor();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await paint(page);
    await child(page).waitFor();
    assert.equal(await dialog(page).count(), 0);
  });

  await run("final-logo-geometry-matches-source", async page => {
    await dialog(page).waitFor();
    const geometry = await page.evaluate(async () => {
      const source = new DOMParser().parseFromString(await (await fetch("/logo.svg")).text(), "image/svg+xml").documentElement;
      const actual = document.querySelector('[aria-label="HGhubX 启动动画"] svg');
      const attributes = (element, names) => names.map(name => element.getAttribute(name));
      const paths = [...actual.querySelectorAll("path")], originalPaths = [...source.querySelectorAll("path")];
      for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = 1800; }
      return {
        actualViewBox: actual.getAttribute("viewBox"), sourceViewBox: source.getAttribute("viewBox"),
        actualPaths: [paths.slice(0, 3).map(path => path.getAttribute("d")).join(""), ...paths.slice(3).map(path => path.getAttribute("d"))],
        sourcePaths: originalPaths.map(path => path.getAttribute("d")),
        actualRects: [...actual.querySelectorAll("rect")].map(rect => attributes(rect, ["x", "y", "width", "height", "rx", "stroke", "stroke-opacity", "stroke-width"])),
        sourceRects: [...source.querySelectorAll("rect")].map(rect => attributes(rect, ["x", "y", "width", "height", "rx", "stroke", "stroke-opacity", "stroke-width"])),
        actualTransform: paths[0].parentElement.getAttribute("transform"), sourceTransform: originalPaths[0].parentElement.getAttribute("transform"),
        actualStops: [...actual.querySelectorAll("stop")].map(stop => attributes(stop, ["offset", "stop-color"])),
        sourceStops: [...source.querySelectorAll("stop")].map(stop => attributes(stop, ["offset", "stop-color"])),
      };
    });
    assert.equal(geometry.actualViewBox, geometry.sourceViewBox);
    assert.deepEqual(geometry.actualPaths, geometry.sourcePaths, "All assembled path geometry exactly matches the official local SVG");
    assert.deepEqual(geometry.actualRects, geometry.sourceRects);
    assert.equal(geometry.actualTransform, geometry.sourceTransform);
    assert.deepEqual(geometry.actualStops, geometry.sourceStops);
    await page.screenshot({ path: `${output}/logo-final.png` });
    const final = await dialog(page).locator("svg path, svg .hg-launch-tile").evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element), matrix = new DOMMatrix(style.transform);
      return { opacity: Number(style.opacity), identity: matrix.isIdentity };
    }));
    assert(final.every(state => state.opacity === 1 && state.identity), "Final animation frame is fully opaque with no residual transform");
  }, { query: "preview=1", width: 1280, height: 800 });

  await run("strict-mode-finish-once-and-cleanup", async page => {
    await dialog(page).waitFor();
    await page.clock.runFor(3000);
    assert.equal(await page.evaluate(() => window.launchAnimationFixture.finishes), 1, "StrictMode effect replay completes once");
    await page.clock.runFor(5000);
    assert.equal(await page.evaluate(() => window.launchAnimationFixture.finishes), 1, "No recurring launch timer");
    await page.evaluate(() => window.launchAnimationFixture.setMounted(false));
    await paint(page);
    await page.clock.runFor(3000);
    assert.equal(await page.evaluate(() => window.launchAnimationFixture.finishes), 1, "Unmount clears handlers and timers");
  }, { query: "preview=1" });

  await run("real-app-startup-gates-media", async page => {
    await dialog(page).waitFor();
    const calls = await page.evaluate(() => window.launchAppCalls);
    assert(!calls.includes("app_boot"), "Account/session initialization waits until the startup gate opens");
    assert(!calls.includes("api_feed") && !calls.includes("api_play"), "Media stays unmounted during intro");
    assert.equal(await page.getByRole("navigation", { name: "主导航", exact: true }).count(), 0);
    await page.clock.runFor(2600);
    await page.getByRole("navigation", { name: "主导航", exact: true }).waitFor();
    await page.waitForFunction(() => window.launchAppCalls.includes("app_boot"));
    await page.waitForFunction(() => window.launchAppCalls.includes("api_feed"));
    assert.equal(await dialog(page).count(), 0, "Slow boot does not hold the intro open");
    await page.screenshot({ path: `${output}/real-app-after-startup.png` });
  }, { realApp: true });

  assert.deepEqual(report.errors, [], "No browser errors");
  if (report.failed.length) process.exitCode = 1;
} catch (error) { report.failed.push({ name: "runner", error: String(error.stack || error) }); process.exitCode = 1; }
finally {
  await browser?.close(); await server?.close();
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(`Launch animation checks: ${report.passed.length} passed, ${report.failed.length} failed. Artifacts: ${output}`);
}
