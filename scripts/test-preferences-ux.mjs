/** Real App + neutral isolated IPC: preference overlay geometry and detail-tag navigation. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = fileURLToPath(new URL(`../test-results/preferences-ux/${Date.now()}/`, import.meta.url));
await mkdir(out, { recursive: true });
const key = (await readFile(`${root}src/contentPreferences.ts`, "utf8")).match(/CONTENT_PREFERENCES_KEY\s*=\s*"([^"]+)"/)[1];
const holdGuideKey = (await readFile(`${root}src/useMobileHoldGuide.ts`, "utf8")).match(/MOBILE_HOLD_GUIDE_KEY\s*=\s*"([^"]+)"/)[1];
const report = { environment: "Real App/Feed/Settings with neutral mocked IPC, no upstream/media traffic or native-device claim", passed: [], failed: [], errors: [], measurements: [] };
const state = page => page.evaluate(() => window.preferencesUXFixture.state);
const menu = page => page.getByRole("dialog", { name: "不感兴趣", exact: true });
const openFeed = async page => { await page.evaluate(() => window.preferencesUXFixture.openFeed()); await page.getByRole("button", { name: "不感兴趣", exact: true }).waitFor(); };
const inside = (r, width, height) => r.left >= -1 && r.top >= -1 && r.right <= width + 1 && r.bottom <= height + 1;
const bounds = async locator => locator.evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; });
const actionable = async locator => locator.evaluate(el => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return el.contains(hit); });
let browser, server;
try {
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } }); await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const run = async (name, body, { width = 375, height = 812, desktop = false, theme = "light", many = false, paused = false, large = false, fakeMedia = false, home = false } = {}) => {
    if (process.env.PREFERENCES_UX_CASE && process.env.PREFERENCES_UX_CASE !== name) return;
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", colorScheme: theme,
      ...(!desktop ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", isMobile: true, hasTouch: true } : {}) });
    await context.addInitScript(({ key, holdGuideKey, theme, paused }) => { localStorage.clear(); localStorage.setItem(holdGuideKey, "1"); localStorage.setItem("hghubx_theme", theme); localStorage.setItem("hghubx_auto_line", "off"); localStorage.setItem(key, JSON.stringify({ blockedTags: [], paused, hideUntagged: false })); }, { key, holdGuideKey, theme, paused });
    if (fakeMedia) await context.addInitScript(() => {
      const paused = new WeakMap();
      window.fakeMediaCalls = { play: 0, pause: 0 };
      Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get() { return paused.get(this) ?? true; } });
      Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get() { return 2; } });
      Object.defineProperty(HTMLMediaElement.prototype, "duration", { configurable: true, get() { return 120; } });
      HTMLMediaElement.prototype.play = function () { window.fakeMediaCalls.play++; paused.set(this, false); this.dispatchEvent(new Event("play")); this.dispatchEvent(new Event("playing")); return Promise.resolve(); };
      HTMLMediaElement.prototype.pause = function () { window.fakeMediaCalls.pause++; const playing = paused.get(this) === false; paused.set(this, true); if (playing) this.dispatchEvent(new Event("pause")); };
      HTMLMediaElement.prototype.load = function () {};
    });
    const page = await context.newPage(); page.setDefaultTimeout(6000);
    page.on("pageerror", error => report.errors.push({ name, error: error.message }));
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/fixture-video.mp4") return route.fulfill({ status: 200, contentType: "video/mp4", body: "" });
      if (url.origin === new URL(origin).origin) return route.continue();
      return route.abort();
    });
    try {
      const query = new URLSearchParams();
      if (many) query.set("many", "1");
      if (home) query.set("home", "1");
      await page.goto(`${origin}tests/preferences-ux.html?${query}`);
      await page.waitForFunction(() => window.preferencesUXFixture?.ready);
      if (large) await page.addStyleTag({ content: ".content-tag-menu :is(p,span,button,h2) { font-size:20px !important; }" });
      await body(page, { width, height, desktop });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No viewport horizontal overflow");
      await page.screenshot({ path: `${out}/${name}.png`, animations: "disabled" });
      report.passed.push(name); console.log(`PASS ${name}`);
    } catch (error) {
      report.failed.push({ name, error: String(error.stack || error) }); console.error(`FAIL ${name}: ${error.message}`);
      await page.screenshot({ path: `${out}/${name}-failure.png`, animations: "disabled" }).catch(() => {});
    } finally { await context.close(); }
  };

  await run("compact-menu-375-normal", async page => {
    await openFeed(page);
    const opener = page.getByRole("button", { name: "不感兴趣", exact: true });
    const openerRect = await bounds(opener);
    assert(openerRect.width >= 44 && openerRect.height >= 44, "Compact icon keeps a 44px target");
    await page.screenshot({ path: `${out}/compact-menu-375-feed-entry.png`, animations: "disabled" });
    await opener.click(); const dialog = menu(page); await dialog.waitFor();
    const rect = await bounds(dialog);
    report.measurements.push({ name: "compact-menu-375-normal", dialog: rect, opener: openerRect });
    assert(rect.height <= 330, `Normal mobile preference menu stays compact: ${rect.height}px <= 330px`);
    assert(inside(rect, 375, 812));
    assert.equal((await opener.textContent()).trim(), "", "Feed preference entry is an icon, not a large text button");
    assert.equal(await dialog.getByRole("group", { name: "选择屏蔽标签", exact: true }).getByRole("button").count(), 3, "Small tag sets show all normalized choices");
    assert.equal(await dialog.getByRole("button", { name: /^全部标签/ }).count(), 0, "Small tag sets need no expansion control");
    const close = dialog.getByRole("button", { name: "关闭不感兴趣", exact: true });
    const confirm = dialog.getByRole("button", { name: "屏蔽所选标签", exact: true });
    assert(await actionable(close) && await actionable(confirm));
    await page.screenshot({ path: `${out}/compact-menu-375-normal-open.png`, animations: "disabled" });
  });

  for (const scenario of [
    { width: 320, height: 694, theme: "light", large: true },
    { width: 375, height: 812, theme: "dark" },
    { width: 844, height: 390, theme: "light" },
    { width: 1280, height: 900, desktop: true, theme: "dark" },
  ]) await run(`menu-layout-${scenario.width}-${scenario.theme}`, async (page, viewport) => {
    await openFeed(page);
    const feedEntry = page.getByRole("button", { name: "不感兴趣", exact: true });
    const entryRect = await bounds(feedEntry);
    assert(entryRect.width >= 44 && entryRect.height >= 44, "Preference icon preserves a 44px target");
    assert.equal((await feedEntry.textContent()).trim(), "");
    await feedEntry.click();
    const dialog = menu(page); await dialog.waitFor();
    const opener = page.getByRole("button", { name: "不感兴趣", exact: true, includeHidden: true });
    assert(await opener.evaluate(el => !!el.closest("[inert]")), "Background app is inert while the menu is open");
    const close = dialog.getByRole("button", { name: "关闭不感兴趣", exact: true });
    const confirm = dialog.getByRole("button", { name: "屏蔽所选标签", exact: true });
    await close.waitFor();
    const compact = { dialog: await bounds(dialog), close: await bounds(close), confirm: await bounds(confirm) };
    for (const [label, r] of Object.entries(compact)) assert(inside(r, viewport.width, viewport.height), `Compact ${label} stays inside viewport`);
    assert(await actionable(close) && await actionable(confirm), "Compact actions stay visible and unobstructed");
    if (viewport.desktop) assert(compact.dialog.width <= 400, "Desktop menu uses at most 400px width");
    const choices = dialog.getByRole("group", { name: "选择屏蔽标签", exact: true }).getByRole("button");
    assert.equal(await choices.count(), 4, "Large tag sets initially show four choices");
    await page.screenshot({ path: `${out}/menu-${viewport.width}-compact.png`, animations: "disabled" });
    await dialog.getByRole("button", { name: "全部标签（40）", exact: true }).click();
    assert.equal(await choices.count(), 40, "Expansion exposes every normalized tag");
    if (viewport.width === 375) {
      const lastTag = await page.evaluate(() => window.preferencesUXFixture.longTag);
      await dialog.getByRole("button", { name: lastTag, exact: true }).click();
      await dialog.getByRole("button", { name: "收起标签", exact: true }).click();
      assert.equal(await choices.count(), 4);
      assert.equal(await confirm.isEnabled(), true, "Collapsing retains the selected hidden tag");
      assert.match(await confirm.textContent(), /1/, "Compact confirm still indicates the saved selection count");
      await dialog.getByRole("button", { name: "全部标签（40）", exact: true }).click();
      assert.equal(await dialog.getByRole("button", { name: lastTag, exact: true }).getAttribute("aria-pressed"), "true");
    }
    const before = { dialog: await bounds(dialog), close: await bounds(close), confirm: await bounds(confirm) };
    for (const [label, r] of Object.entries(before)) assert(inside(r, viewport.width, viewport.height), `${label} stays inside viewport`);
    assert(await actionable(close) && await actionable(confirm), "Header/footer controls are not covered before scrolling");
    assert(before.close.height >= 44 && before.confirm.height >= 44, "Close and confirm have >=44px targets");
    const scroll = dialog.locator("[data-tag-menu-scroll]");
    assert(await scroll.evaluate(el => el.scrollHeight > el.clientHeight), "Many tags scroll only in the tag body");
    await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const after = await bounds(confirm);
    assert(Math.abs(after.top - before.confirm.top) < 1, "Confirm remains fixed when tags scroll");
    assert(await actionable(close) && await actionable(confirm), "Header/footer remain usable after scrolling");
    assert(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), "Long unbroken tags stay in dialog width");
    assert.equal(await page.getByRole("dialog").count(), 1);
    report.measurements.push({ name: `menu-${viewport.width}`, compact, before, after });
    await page.screenshot({ path: `${out}/menu-${viewport.width}-scrolled.png`, animations: "disabled" });
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
    assert.equal(await opener.evaluate(el => !!el.closest("[inert]")), false, "Closing the menu restores background interaction");
    assert(await page.getByRole("button", { name: "不感兴趣", exact: true }).evaluate(el => el === document.activeElement), "Escape restores the opener focus");
  }, { ...scenario, many: true });

  await run("paused-save-preserves-pause-and-selection", async page => {
    await openFeed(page); await page.getByRole("button", { name: "不感兴趣", exact: true }).click();
    const dialog = menu(page);
    await dialog.getByText(/暂停/).first().waitFor();
    await dialog.getByRole("button", { name: "自然观察", exact: true }).click();
    assert.equal(await dialog.getByRole("button", { name: "自然观察", exact: true }).getAttribute("aria-pressed"), "true");
    await dialog.getByRole("button", { name: "屏蔽所选标签", exact: true }).click();
    await page.waitForFunction(() => window.preferencesUXFixture.state.preferences.blockedTags.includes("自然观察"));
    assert.equal((await state(page)).preferences.paused, true);
    assert.equal(await page.locator("[data-content-block-notice]").count(), 0);
  }, { paused: true });

  await run("storage-failure-remains-visible", async page => {
    await openFeed(page); await page.getByRole("button", { name: "不感兴趣", exact: true }).click();
    await page.evaluate(() => window.preferencesUXFixture.storageFault(true));
    await menu(page).getByRole("button", { name: "自然观察", exact: true }).click();
    await menu(page).getByRole("button", { name: "屏蔽所选标签", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: /保存失败/ }).waitFor();
    assert.equal((await state(page)).preferences.paused, true);
    assert((await state(page)).preferences.blockedTags.includes("自然观察"));
  }, { paused: true });

  await run("silent-skip-storage-retry-and-short-screen", async page => {
    await openFeed(page); await page.getByRole("button", { name: "不感兴趣", exact: true }).click();
    await page.evaluate(() => window.preferencesUXFixture.storageFault(true));
    const longTag = await page.evaluate(() => window.preferencesUXFixture.longTag);
    await menu(page).getByRole("button", { name: "全部标签（40）", exact: true }).click();
    await menu(page).getByRole("button", { name: longTag, exact: true }).click();
    await menu(page).getByRole("button", { name: "屏蔽所选标签", exact: true }).click();
    await page.getByText("当前列表没有可播放内容", { exact: true }).waitFor();
    await menu(page).waitFor({ state: "hidden" });
    assert.equal(await page.locator("[data-content-block-notice]").count(), 0, "A matching rule skips content without showing a block dialog");
    assert.equal(await page.getByRole("button", { name: "本次查看", exact: true }).count(), 0);
    assert.equal(await page.locator("video:visible").count(), 0, "The blocked item is removed even when saving fails");
    const notice = page.getByRole("alert").and(page.locator("[data-preference-storage-notice]")); await notice.waitFor();
    await page.addStyleTag({ content: "[data-preference-storage-notice] :is(p,span,button) { font-size:20px !important; overflow-wrap:anywhere; }" });
    assert.equal(await notice.getAttribute("role"), "alert");
    assert.match(await notice.textContent(), /保存失败/);
    const retry = notice.getByRole("button", { name: "重试保存", exact: true }); await retry.scrollIntoViewIfNeeded();
    assert(inside(await bounds(retry), 844, 390) && await actionable(retry), "Storage retry is reachable on short landscape screen");
    await page.evaluate(() => window.preferencesUXFixture.storageFault(false)); await retry.click();
    await notice.waitFor({ state: "hidden" });
    assert((await state(page)).preferences.blockedTags.includes(longTag));
    assert.equal((await state(page)).storageError, null);
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
    assert(saved.blockedTags.includes(longTag), "Retry persists the in-memory rule without authorizing blocked playback");
    await page.getByText("当前列表没有可播放内容", { exact: true }).waitFor();
    assert.equal(await page.locator("video:visible").count(), 0);
    const back = page.getByRole("button", { name: "返回", exact: true });
    assert(inside(await bounds(back), 844, 390) && await actionable(back), "The empty player retains an accessible back action");
    await back.click();
    await page.waitForFunction(() => window.preferencesUXFixture.state.stack.length === 0);
    await page.evaluate(() => window.preferencesUXFixture.pause(true));
    await openFeed(page);
    await page.getByRole("button", { name: "视频详情", exact: true }).waitFor();
    assert((await state(page)).preferences.blockedTags.includes(longTag), "Pausing restores access while retaining the saved rule");
  }, { width: 844, height: 390, many: true });

  await run("home-storage-failure-survives-video-skip", async page => {
    await page.getByRole("button", { name: "不感兴趣", exact: true }).click();
    await page.evaluate(() => window.preferencesUXFixture.storageFault(true));
    await menu(page).getByRole("button", { name: "自然观察", exact: true }).click();
    await menu(page).getByRole("button", { name: "屏蔽所选标签", exact: true }).click();
    await page.getByText("已隐藏不感兴趣的内容", { exact: true }).waitFor();
    const notice = page.locator("[data-preference-storage-notice]:visible"); await notice.waitFor();
    assert.equal(await notice.getAttribute("role"), "alert");
    assert.match(await notice.textContent(), /保存失败/);
    assert.equal(await page.locator("video:visible").count(), 0, "Home has removed the blocked video");
    assert.equal(await page.getByRole("dialog").count(), 0, "Skipping the video closes its menu");
    const retry = notice.getByRole("button", { name: "重试保存", exact: true });
    assert(inside(await bounds(retry), 375, 812) && await actionable(retry), "Home storage retry stays reachable after Feed unmount");
    await page.screenshot({ path: `${out}/home-storage-failure-notice.png`, animations: "disabled" });
    await page.evaluate(() => window.preferencesUXFixture.storageFault(false)); await retry.click();
    await notice.waitFor({ state: "hidden" });
    assert((await state(page)).preferences.blockedTags.includes("自然观察"), "Retry persists without removing the user's blocked tag");
    assert.equal((await state(page)).storageError, null);
  }, { home: true });

  await run("menu-pauses-media-and-retains-manual-pause", async page => {
    await openFeed(page); const video = page.locator("video"); await video.waitFor();
    await video.evaluate(async el => { el.dispatchEvent(new Event("loadedmetadata")); el.dispatchEvent(new Event("loadeddata")); await el.play(); });
    assert.equal(await video.evaluate(el => el.paused), false, "Stub media starts playing before opening the menu");
    await page.getByRole("button", { name: "暂停", exact: true }).waitFor();
    await page.getByRole("button", { name: "不感兴趣", exact: true }).click(); await menu(page).waitFor();
    assert.equal(await video.evaluate(el => el.paused), true, "Menu pauses active playback");
    await menu(page).getByRole("button", { name: "关闭不感兴趣", exact: true }).click(); await menu(page).waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.querySelector("video").paused === false);
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    assert.equal(await video.evaluate(el => el.paused), true);
    const calls = await page.evaluate(() => window.fakeMediaCalls.play);
    await page.getByRole("button", { name: "不感兴趣", exact: true }).click(); await menu(page).waitFor();
    await page.keyboard.press("Escape"); await menu(page).waitFor({ state: "hidden" });
    assert.equal(await video.evaluate(el => el.paused), true, "Previously manual-paused playback stays paused after menu dismissal");
    assert.equal(await page.evaluate(() => window.fakeMediaCalls.play), calls, "Dismissal does not call play for manually paused media");
  }, { width: 1280, height: 900, desktop: true, fakeMedia: true });

  await run("manage-opens-content-preferences-directly", async page => {
    await openFeed(page); await page.getByRole("button", { name: "不感兴趣", exact: true }).click();
    await menu(page).getByRole("button", { name: "管理屏蔽标签", exact: true }).click();
    const trigger = page.getByRole("button", { name: "内容偏好设置", exact: true }); await trigger.waitFor();
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    await page.getByRole("textbox", { name: "添加屏蔽标签", exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0, "Management is not underneath an old menu");
    const current = (await state(page)).stack.at(-1);
    assert.equal(current.kind, "settings");
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await page.getByRole("button", { name: "不感兴趣", exact: true }).waitFor();
    assert.equal(await menu(page).count(), 0, "Returning from settings does not reopen old menu");
  });

  for (const desktop of [false, true]) await run(`details-tags-navigate-and-return-${desktop ? "desktop" : "mobile"}`, async page => {
    await openFeed(page);
    const before = (await state(page)).stack.at(-1);
    await page.getByRole("button", { name: "视频详情", exact: true }).click();
    const tag = page.getByRole("button", { name: "查看标签 自然观察", exact: true }); await tag.waitFor();
    assert.equal(await tag.count(), 1, "Duplicate tags collapse");
    assert.equal(await page.getByRole("button", { name: "查看标签 travel", exact: true }).count(), 0, "Case duplicates collapse");
    const rect = await bounds(tag); assert(rect.height >= 44 && rect.width >= 44);
    await page.screenshot({ path: `${out}/details-tags-${desktop ? "desktop" : "mobile"}.png`, animations: "disabled" });
    await tag.click();
    await page.getByRole("heading", { name: "自然观察", exact: true }).waitFor();
    await page.waitForFunction(() => window.preferencesUXFixture.calls.some(call => call.command === "api_tag_videos" && call.args.tag === "自然观察"));
    const current = (await state(page)).stack.at(-1);
    assert.equal(current.kind, "tag"); assert.equal(current.tag, "自然观察");
    assert.equal(await page.getByRole("dialog").count(), 0, "Detail sheet closes before tag route");
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await page.getByRole("button", { name: "视频详情", exact: true }).waitFor();
    const restored = (await state(page)).stack.at(-1);
    assert.equal(restored.key, before.key); assert.equal(restored.startEp, 2); assert.deepEqual(restored.videoIds, [41]);
    assert.equal(await menu(page).count(), 0);
    await page.getByRole("button", { name: "视频详情", exact: true }).click();
    await page.getByRole("button", { name: "调整内容偏好", exact: true }).click();
    await menu(page).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 1, "Detail preference action closes details before opening the menu");
    assert.equal(await page.getByRole("button", { name: "查看标签 自然观察", exact: true }).count(), 0);
    await menu(page).getByRole("button", { name: "关闭不感兴趣", exact: true }).click();
    await menu(page).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "视频详情", exact: true }).waitFor();
  }, desktop ? { width: 1280, height: 900, desktop: true, theme: "dark" } : {});

  assert.deepEqual(report.errors, []);
  if (report.failed.length) process.exitCode = 1;
} catch (error) { report.failed.push({ name: "runner", error: String(error.stack || error) }); process.exitCode = 1; }
finally { await browser?.close(); await server?.close(); await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2)); console.log(`Preferences UX checks: ${report.passed.length} passed, ${report.failed.length} failed. Artifacts: ${out}`); }
