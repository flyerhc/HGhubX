// Executed by the existing GitHub Actions playback workflow with scenarios=tv.
// Real TV bootstrap/components/Worker/IndexedDB. All IPC/media remain fixtures.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";
import { chromium } from "playwright-core";
import { installTvFixture } from "../tests/tv-remote-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "tv-remote", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { environment: "Chromium actual TV edition; strict mock IPC; generated local MP4; no upstream", cases: [], errors: [], external: [], screenshots: [] };
let vite, browser, mediaDirectory, origin;
const contexts = [];
let activeContext;
const savedEdition = process.env.VITE_APP_EDITION;
async function scenario(name, run) {
  const item = { name, status: "running" }; report.cases.push(item);
  try { item.metrics = await run(); item.status = "passed"; console.log(`PASS TV ${name}`); }
  catch (error) { item.status = "failed"; item.error = String(error.stack || error); throw error; }
  finally {
    if (activeContext) {
      for (const page of activeContext.pages()) {
        const unknown = await page.evaluate(() => window.__tvFixture?.unknown || []).catch(() => []);
        report.errors.push(...unknown.map(command => `Unexpected fixture IPC: ${command}`));
        if (item.status === "failed") await page.screenshot({ path: join(output, `${name}-failed.png`) }).catch(() => {});
      }
      await activeContext.tracing.stop({ path: join(output, `${name}-trace.zip`) }).catch(() => {});
      await activeContext.close();
      contexts.splice(contexts.indexOf(activeContext), 1); activeContext = undefined;
    }
    await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  }
}
async function open({ accepted = true, isolated = false, width = 1280, height = 720 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", userAgent: "Mozilla/5.0 (Linux; Android 12; TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" });
  contexts.push(context);
  activeContext = context;
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on("pageerror", error => report.errors.push(error.message));
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.origin === "http://hg.localhost" && url.pathname === "/img") return route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="360"><rect width="240" height="360" fill="#234960"/><path d="M95 140L160 180L95 220Z" fill="#60cdff"/></svg>' });
    if (url.origin === "http://hg.localhost" && url.pathname === "/seg") {
      const data = await readFile(join(mediaDirectory, "fixture.mp4"));
      const range = route.request().headers().range;
      const match = /^bytes=(\d+)-(\d*)$/.exec(range || "");
      if (match) {
        const start = Number(match[1]), end = match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
        return route.fulfill({ status: 206, contentType: "video/mp4", headers: { "Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${data.length}` }, body: data.subarray(start, end + 1) });
      }
      return route.fulfill({ status: 200, contentType: "video/mp4", headers: { "Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes" }, body: data });
    }
    if (url.protocol === "blob:" || url.protocol === "data:") return route.continue();
    report.external.push(url.href); return route.abort("blockedbyclient");
  });
  await page.addInitScript(installTvFixture, { accepted });
  await page.goto(`${origin}${isolated ? "/tests/tv-remote.html" : "/"}`);
  if (!isolated && accepted) await page.locator('[data-tv-focus="nav-home"]').waitFor();
  return { context, page };
}
const activate = async (page, key) => {
  const element = page.locator(`[data-tv-focus=${JSON.stringify(key)}]`).filter({ visible: true }).first();
  await page.waitForFunction(key => {
    const element = [...document.querySelectorAll("[data-tv-focus]")].find(item => item.getAttribute("data-tv-focus") === key && item.getClientRects().length);
    return !!element && !element.matches(":disabled");
  }, key);
  await element.focus(); await page.keyboard.press("Enter");
};
const calls = (page, command) => page.evaluate(command => window.__tvFixture.calls.filter(call => call.command === command), command);
const activeKey = page => page.evaluate(() => document.activeElement?.getAttribute("data-tv-focus"));
const catalogStatus = page => page.evaluate(async () => {
  const request = indexedDB.open("hghubx-tv-catalog-v1", 1);
  const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const read = db.transaction("checkpoints", "readonly").objectStore("checkpoints").get(window.__tvFixture.base);
  const value = await new Promise((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); }); db.close(); return value;
});
try {
  process.env.VITE_APP_EDITION = "tv";
  mediaDirectory = await mkdtemp(join(tmpdir(), "hghubx-tv-media-"));
  execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10", "-t", "60", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(mediaDirectory, "fixture.mp4")], { timeout: 60000 });
  vite = await createServer({ root, cacheDir: join(root, "node_modules/.vite-tv-remote"), server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, open: false } });
  await vite.listen(); origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || chromium.executablePath(), args: ["--autoplay-policy=no-user-gesture-required"] });
  report.browser = browser.version();
  await scenario("agreement-gate-single-controller", async () => {
    const { page } = await open({ accepted: false });
    await page.locator('[data-tv-focus="agreement-checkbox"]').waitFor();
    const pre = await page.evaluate(() => ({ ready: window.__tvFixture.startupReady, keys: window.__tvFixture.keyboardListeners,
      native: window.__tvFixture.nativeListeners, requests: window.__tvFixture.calls.filter(call => /^(api_|app_boot|line_auto|line_health)/.test(call.command)) }));
    assert.equal(pre.ready, 1); assert.equal(pre.keys, 1); assert.equal(pre.native, 1); assert.deepEqual(pre.requests, []);
    assert(await page.locator('[data-tv-focus="agreement-accept"]').isDisabled());
    await activate(page, "agreement-checkbox");
    assert(await page.locator('[data-tv-focus="agreement-checkbox"]').isChecked());
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    });
    assert(await page.locator('[data-tv-focus="agreement-checkbox"]').isChecked(), "Confirm repeat must not toggle twice");
    await activate(page, "agreement-accept");
    await page.locator('[data-tv-focus="nav-home"]').waitFor();
    assert.equal((await calls(page, "app_boot")).length, 1);
    assert.equal(await page.locator("#hg-startup-error").count(), 0);
    return pre;
  });
  await scenario("keyboard-focus-modal-tag-gate", async () => {
    const { page } = await open();
    const card = page.locator('[data-tv-region="home-推荐"] [data-tv-focus="video:1"]');
    await card.waitFor(); await card.focus(); await page.keyboard.press("Enter");
    await page.locator('[data-tv-focus="detail:video:1:more"]').waitFor();
    await activate(page, "detail:video:1:more");
    await page.getByRole("dialog", { name: "屏蔽标签" }).waitFor();
    for (const key of ["Tab", "ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Tab"]) {
      await page.keyboard.press(key);
      assert(await page.evaluate(() => !!document.activeElement?.closest('[data-tv-modal="detail-tags:video:1"]')), "Modal must own focus");
    }
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-tv-focus") === "detail:video:1:more");
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      window.__tvFixture.back(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
    });
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-tv-focus") === "video:1" && !!document.activeElement?.closest('[data-tv-region="home-推荐"]'));
    assert.equal(await page.evaluate(() => window.__tvFixture.exits), 0, "Native and keyboard back pair must pop once");
    await page.keyboard.press("Enter"); await activate(page, "detail:video:1:more");
    await activate(page, "block:都市"); await activate(page, "block-confirm");
    await page.getByRole("heading", { name: "内容已屏蔽" }).waitFor();
    assert.equal(await page.locator(".tv-detail-cover img").count(), 0); assert.equal(await page.locator("video").count(), 0);
    return { focusRestored: true, modalTrapped: true, duplicateBackSuppressed: true, blockedMediaUnmounted: true };
  });
  await scenario("actual-worker-initials-resume-errors", async () => {
    const { page } = await open();
    await activate(page, "nav-search");
    await page.getByText(/目录同步完成/).waitFor();
    const status = await catalogStatus(page); assert.equal(status.count, 12); assert.equal(status.complete, true);
    const matches = await page.evaluate(async () => {
      const { queryCatalog } = await import("/src/tv/search/catalog.ts");
      const p = { blockedTags: [], paused: false, hideUntagged: false }, result = {};
      for (const query of ["WDSJ", "wdsj", "DSJ", "wdai sj2", "W-S_D.J"]) result[query] = (await queryCatalog(window.__tvFixture.base, query, 0, p)).items.map(item => `${item.kind}:${item.id}`);
      return result;
    });
    assert.deepEqual(matches.WDSJ, matches.wdsj); assert.deepEqual(matches.WDSJ, matches["W-S_D.J"]);
    assert.deepEqual(matches.WDSJ.slice(0, 3), ["video:1", "video:4", "video:2"]); assert(matches.DSJ.includes("video:1")); assert.deepEqual(matches["wdai sj2"], ["video:5"]);
    for (const key of "WDSJ") await activate(page, `search:key:${key}`);
    await page.waitForTimeout(350); assert.equal(await activeKey(page), "search:key:J");
    await page.waitForFunction(() => document.querySelector(".tv-search-query")?.textContent === "WDSJ");
    assert.equal((await calls(page, "api_search")).length, 0); assert((await page.evaluate(() => window.__tvFixture.postMax)) <= 2);
    await page.evaluate(async () => { window.__tvFixture.catalogMode = "repeat"; await (await import("/src/tv/search/catalog.ts")).retryCatalog(window.__tvFixture.base, true); });
    await page.getByText(/上游返回了重复目录页/).waitFor();
    const failed = await catalogStatus(page); assert.equal(failed.complete, false); assert.equal(failed.channels[0].nextPage, 2);
    assert.equal(await page.locator('[data-tv-focus="search:video:1"]').count(), 1, "Sync errors retain old matches");
    await page.evaluate(async () => { window.__tvFixture.catalogMode = "normal"; await (await import("/src/tv/search/catalog.ts")).retryCatalog(window.__tvFixture.base, true); });
    await page.getByText(/目录同步完成/).waitFor();
    return { matches, checkpoint: status, repeatedPageStopped: true, maxPostConcurrency: await page.evaluate(() => window.__tvFixture.postMax) };
  });
  await scenario("post-qualification-retry-source-discard", async () => {
    const { page } = await open({ isolated: true });
    const result = await page.evaluate(async () => {
      const { qualifyVisiblePosts } = await import("/src/tv/postEligibility.ts");
      const items = window.__tvFixture.posts.map(post => ({ ...post, kind: "post" }));
      window.__tvFixture.failPostIds = [1];
      const first = await qualifyVisiblePosts(items, { source: window.__tvFixture.base, isCurrent: () => true, allowed: item => item.id !== 6 });
      window.__tvFixture.failPostIds = [];
      const retry = await qualifyVisiblePosts([items[0]], { source: window.__tvFixture.base, isCurrent: () => true, allowed: () => true }, true);
      let current = true;
      const pending = qualifyVisiblePosts(items, { source: window.__tvFixture.base, isCurrent: () => current, allowed: () => true }, true);
      current = false;
      const stale = await pending;
      return { first: { items: first.items.map(item => item.id), retryable: first.retryable }, retry: retry.items.map(item => item.id), stale: stale.items,
        calls: window.__tvFixture.calls.filter(call => call.command === "api_post_playback").map(call => call.args.id), max: window.__tvFixture.postMax };
    });
    assert.deepEqual(result.first, { items: [2, 3, 4, 5], retryable: 1 }); assert.deepEqual(result.retry, [1]); assert.deepEqual(result.stale, []);
    assert(!result.calls.includes(6), "Blocked tags must prevent even eligibility parsing"); assert(result.max <= 2);
    return result;
  });
  await scenario("library-atomic-migration", async () => {
    const { page } = await open({ isolated: true });
    return page.evaluate(async () => (await import("/tests/tv-library.ts")).runTvLibraryTests());
  });
  await scenario("player-remote-seek-last-part", async () => {
    const { page } = await open();
    await page.locator('[data-tv-region="home-推荐"] [data-tv-focus="video:1"]').waitFor();
    await page.locator('[data-tv-region="home-推荐"] [data-tv-focus="video:1"]').focus(); await page.keyboard.press("Enter");
    await activate(page, "detail:video:1:part:2");
    await page.waitForFunction(() => document.querySelector("video")?.currentTime > .1);
    await page.waitForFunction(() => document.querySelector(".tv-player-controls")?.hidden === true, null, { timeout: 10000 });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".tv-player-controls")?.hidden === false && document.activeElement?.getAttribute("data-tv-focus") === "player:play");
    assert.equal(await page.locator("video").evaluate(video => video.paused), false, "First confirm reveals without toggling");
    await page.keyboard.press("Enter"); await page.waitForFunction(() => document.querySelector("video")?.paused);
    await activate(page, "player:progress");
    const before = await page.locator("video").evaluate(video => video.currentTime);
    await page.keyboard.press("ArrowRight");
    assert(Math.abs(await page.locator("video").evaluate(video => video.currentTime) - before) < .5, "Seek preview must not commit");
    await page.keyboard.press("Escape"); assert.equal(await page.locator(".tv-player-seek-hint").count(), 0);
    await page.waitForTimeout(200);
    await page.keyboard.press("ArrowRight"); await page.keyboard.press("Enter");
    await page.waitForFunction(before => document.querySelector("video").currentTime >= before + 9, before);
    await page.locator("video").evaluate(video => { video.currentTime = video.duration - 1; });
    await page.keyboard.press("MediaPlay");
    await page.getByRole("dialog", { name: /播放完毕/ }).waitFor();
    assert.equal(await page.locator('[data-tv-focus="player:ended-next"]').count(), 0);
    assert((await calls(page, "api_play")).every(call => call.args.id === 1 && call.args.ep === 2));
    return { confirmTwoStages: true, previewCancelCommit: true, finalPartNoOtherWork: true };
  });
  await scenario("720p-1080p-4k-layout", async () => {
    const { page } = await open(); const measurements = [];
    await page.locator('[data-tv-region="home-推荐"] .tv-card').first().waitFor();
    for (const [width, height] of [[1280, 720], [1920, 1080], [3840, 2160]]) {
      await page.setViewportSize({ width, height });
      const card = page.locator('[data-tv-region="home-推荐"] .tv-card').first(); await card.focus();
      const size = await card.evaluate(element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, bottom: box.bottom,
        text: parseFloat(getComputedStyle(element.querySelector("strong")).fontSize), helper: parseFloat(getComputedStyle(element.querySelector("small")).fontSize), outline: getComputedStyle(element).outlineStyle }; });
      assert(size.text >= 18 * width / 960 - .1); assert(size.helper >= 16 * width / 960 - .1); assert.equal(size.outline, "solid");
      assert(size.x >= 0 && size.right <= width && size.y >= 0 && size.bottom <= height);
      const file = `home-${width}x${height}.png`; await page.screenshot({ path: join(output, file), animations: "disabled" }); report.screenshots.push(file); measurements.push({ width, height, ...size });
    }
    return measurements;
  });
  await scenario("standard-build-excludes-tv-resources", async () => {
    await vite.close(); vite = undefined;
    process.env.VITE_APP_EDITION = "standard";
    const modules = new Set();
    const result = await build({ root, logLevel: "warn", plugins: [{ name: "capture-standard-module-graph", generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) if (file.type === "chunk") for (const id of Object.keys(file.modules)) modules.add(id);
    } }], build: { write: false } });
    const forbidden = [...modules].filter(id => /\/src\/tv\/|\/pinyin-pro\//.test(id));
    assert.deepEqual(forbidden, [], "Standard app bundle must not contain TV modules or pinyin-pro");
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output || []);
    const css = outputs.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => String(item.source)).join("\n");
    assert(!css.includes(".tv-search-keyboard"));
    return { modules: modules.size, forbidden, emitted: outputs.map(item => item.fileName) };
  });
  for (const context of contexts) for (const page of context.pages()) {
    assert.deepEqual(await page.evaluate(() => window.__tvFixture?.unknown || []), [], "Unexpected mock IPC is a hard failure");
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.external, []);
} catch (error) {
  report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;
} finally {
  for (const [index, context] of contexts.entries()) { await context.tracing.stop({ path: join(output, `trace-${index}.zip`) }).catch(() => {}); await context.close(); }
  await browser?.close(); await vite?.close();
  if (mediaDirectory) await rm(mediaDirectory, { recursive: true, force: true });
  if (savedEdition === undefined) delete process.env.VITE_APP_EDITION; else process.env.VITE_APP_EDITION = savedEdition;
  report.passed = report.cases.filter(item => item.status === "passed").length;
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(`TV remote acceptance: ${report.passed}/${report.cases.length} scenarios. Artifacts: ${output}`);
}
