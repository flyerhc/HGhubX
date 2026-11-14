/** Actual main.tsx + StartupGate, isolated native IPC/storage and zero upstream traffic. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(new URL(`../test-results/disclaimer-gate/${Date.now()}/`, import.meta.url));
await mkdir(output, { recursive: true });
const source = await readFile(`${root}src/usageAgreement.ts`, "utf8").catch(() => "");
// The baseline predates the agreement module; keeping its product tree intact lets the same test expose the missing gate.
const key = source.match(/USAGE_AGREEMENT_KEY\s*=\s*"([^"]+)"/)?.[1] || "hghubx_usage_agreement";
const version = source.match(/USAGE_AGREEMENT_VERSION\s*=\s*"([^"]+)"/)?.[1] || "2026-11-15-v1";
const accepted = { version, accepted: true, acceptedAt: "2026-11-15T00:00:00.000Z" };
const report = { environment: "Actual main.tsx/StartupGate with offline IPC and controlled storage; no upstream/media or native-device claim", passed: [], failed: [], errors: [], measurements: [] };
const intro = page => page.getByRole("dialog", { name: "HGhubX 启动动画", exact: true });
const agreement = page => page.getByRole("dialog", { name: "使用条款与免责声明", exact: true });
const acceptButton = page => page.getByRole("button", { name: "签署同意并继续", exact: true });
const calls = page => page.evaluate(() => window.disclaimerGateFixture.calls.map(call => call.command));
const forbidden = commands => commands.filter(command => command === "app_boot" || command.startsWith("api_") || command.startsWith("line_"));
const gated = async page => {
  assert.deepEqual(forbidden(await calls(page)), [], "Unsigned startup must not initialize account, content, playback or line selection");
  assert.equal(await page.getByRole("navigation", { name: "主导航", exact: true }).count(), 0, "Application is not mounted before agreement acceptance");
  assert.equal(await page.locator("video").count(), 0);
};
const finishIntro = async page => { await page.getByRole("button", { name: "跳过启动动画", exact: true }).click(); await page.clock.runFor(32); };
const accept = async page => { await agreement(page).getByRole("checkbox").check(); await acceptButton(page).click(); await page.clock.runFor(32); };
const mounted = async page => { await page.getByRole("navigation", { name: "主导航", exact: true }).waitFor(); await page.waitForFunction(() => ["app_boot", "api_feed", "line_auto"].every(command => window.disclaimerGateFixture.calls.some(call => call.command === command))); };
const bounds = locator => locator.evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; });
const inside = (r, w, h) => r.left >= -1 && r.right <= w + 1 && r.top >= -1 && r.bottom <= h + 1;
const actionable = locator => locator.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); });
let server, browser;
try {
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } }); await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const run = async (name, body, { width = 375, height = 812, theme = "light", reduced = false, record = null, android = false, readFault = false, large = false } = {}) => {
    if (process.env.DISCLAIMER_CASE && process.env.DISCLAIMER_CASE !== name) return;
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: reduced ? "reduce" : "no-preference",
      ...(width < 900 ? { isMobile: true, hasTouch: true, userAgent: android ? "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36" : "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" } : {}) });
    await context.addInitScript(({ key, theme, record }) => {
      localStorage.setItem("hghubx_theme", theme); localStorage.setItem("hghubx_auto_line", "on");
      if (!sessionStorage.getItem("disclaimer-fixture-seeded")) {
        sessionStorage.setItem("disclaimer-fixture-seeded", "1");
        if (record !== null) localStorage.setItem(key, record); else localStorage.removeItem(key);
      }
    }, { key, theme, record });
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    page.on("pageerror", error => report.errors.push({ name, error: error.message }));
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
    await page.clock.install();
    try {
      await page.goto(`${origin}tests/disclaimer-gate.html?${new URLSearchParams({ agreementKey: key, theme, ...(readFault ? { readFault: "1" } : {}) })}`);
      await page.waitForFunction(() => window.disclaimerGateFixture?.ready);
      if (large) await page.addStyleTag({ content: ".hg-agreement :is(p,span,button,h2) { font-size:20px!important; }" });
      await body(page, { width, height });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No horizontal viewport overflow");
      await page.screenshot({ path: `${output}/${name}.png`, animations: "disabled" });
      report.passed.push(name); console.log(`PASS ${name}`);
    } catch (error) {
      report.failed.push({ name, error: String(error.stack || error) }); console.error(`FAIL ${name}: ${error.message}`);
      await page.screenshot({ path: `${output}/${name}-failure.png`, animations: "disabled" }).catch(() => {});
    } finally { await context.close(); }
  };

  await run("fresh-launch-no-network-before-acceptance", async page => {
    await intro(page).waitFor(); await gated(page);
    await finishIntro(page); await agreement(page).waitFor(); await gated(page);
    assert.equal(await acceptButton(page).isEnabled(), false);
    assert.equal(await agreement(page).getByRole("checkbox").isChecked(), false);
    await accept(page); await mounted(page);
    assert.equal(await agreement(page).count(), 0);
  });
  await run("automatic-animation-completion-stops-at-agreement", async page => {
    await intro(page).waitFor(); await page.clock.runFor(2600); await agreement(page).waitFor(); await gated(page);
  });
  await run("reduced-motion-does-not-bypass-agreement", async page => {
    await page.clock.runFor(250); await agreement(page).waitFor(); await gated(page);
  }, { reduced: true });
  await run("acceptance-persists-and-version-change-reprompts", async page => {
    await finishIntro(page); await accept(page); await mounted(page);
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
    assert.deepEqual(Object.keys(stored).sort(), ["accepted", "acceptedAt", "version"]);
    assert.equal(stored.version, version); assert.equal(stored.accepted, true); assert(Number.isFinite(Date.parse(stored.acceptedAt)));
    await page.reload(); await page.waitForFunction(() => window.disclaimerGateFixture?.ready);
    await intro(page).waitFor(); await gated(page); await finishIntro(page); await mounted(page);
    assert.equal(await agreement(page).count(), 0, "Same-version stored acceptance skips the agreement");
    await page.evaluate(({ key, stored }) => localStorage.setItem(key, JSON.stringify({ ...stored, version: `${stored.version}-previous` })), { key, stored });
    await page.reload(); await page.waitForFunction(() => window.disclaimerGateFixture?.ready);
    await finishIntro(page); await agreement(page).waitFor(); await gated(page);
  });
  for (const [label, record] of [
    ["malformed", "{bad-json"], ["legacy-string", version],
    ["invalid-date", JSON.stringify({ ...accepted, acceptedAt: "invalid" })],
    ["unsigned", JSON.stringify({ ...accepted, accepted: false })],
  ]) await run(`stored-${label}-requires-confirmation`, async page => {
    await finishIntro(page); await agreement(page).waitFor(); await gated(page);
    assert.equal(await acceptButton(page).isEnabled(), false);
  }, { record });
  await run("storage-read-denial-keeps-gate", async page => {
    await finishIntro(page); await agreement(page).waitFor(); await gated(page);
    await page.evaluate(() => window.disclaimerGateFixture.storageFault("none"));
    await accept(page); await mounted(page);
  }, { record: JSON.stringify(accepted), readFault: true });
  for (const mode of ["write", "discard"]) await run(`storage-${mode}-failure-and-retry`, async page => {
    await finishIntro(page); await agreement(page).waitFor();
    await page.evaluate(mode => window.disclaimerGateFixture.storageFault(mode), mode);
    await accept(page); await page.getByRole("alert").filter({ hasText: /协议确认未保存/ }).waitFor(); await gated(page);
    assert.equal(await acceptButton(page).isEnabled(), true, "The explicit agreement action can retry saving");
    await page.evaluate(() => window.disclaimerGateFixture.storageFault("none"));
    await acceptButton(page).click(); await page.clock.runFor(32); await mounted(page);
  });
  await run("decline-escape-and-return-never-mount-app", async page => {
    await finishIntro(page); await agreement(page).waitFor();
    await page.getByRole("button", { name: "不同意", exact: true }).click();
    await page.getByRole("heading", { name: "应用尚未启动", exact: true }).waitFor(); await gated(page);
    assert.equal(await page.getByRole("button", { name: "退出应用", exact: true }).count(), 0, "iOS offers no unsupported forced-exit action");
    await page.getByRole("button", { name: "返回阅读", exact: true }).click(); await agreement(page).waitFor();
    assert.equal(await acceptButton(page).isEnabled(), false); await gated(page);
    await page.keyboard.press("Escape"); await page.getByRole("heading", { name: "应用尚未启动", exact: true }).waitFor(); await gated(page);
  });
  await run("android-back-keeps-gate-and-exit-does-not-accept", async page => {
    await finishIntro(page); await agreement(page).waitFor();
    await page.waitForFunction(() => window.disclaimerGateFixture.hasHardwareBack());
    await page.evaluate(() => window.disclaimerGateFixture.hardwareBack());
    await page.getByRole("heading", { name: "应用尚未启动", exact: true }).waitFor(); await gated(page);
    await page.getByRole("button", { name: "退出应用", exact: true }).click();
    await page.waitForFunction(() => window.disclaimerGateFixture.calls.some(call => call.command === "plugin:app|exit")); await gated(page);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
  }, { android: true });

  await run("accepted-user-can-review-agreement-in-settings", async page => {
    await finishIntro(page); await mounted(page);
    const stored = await page.evaluate(key => localStorage.getItem(key), key);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "其他设置", exact: true }).click();
    await page.getByRole("button", { name: /^使用条款与免责声明/ }).click();
    const panel = agreement(page); await panel.waitFor();
    assert.equal(await panel.getByRole("heading", { level: 2 }).count(), 7, "Read-only dialog includes all six agreement sections and its title");
    assert.equal(await panel.getByRole("checkbox").count(), 0, "Read-only agreement has no repeat-signature controls");
    assert.equal(await acceptButton(page).count(), 0);
    await page.screenshot({ path: `${output}/settings-agreement-readonly.png`, animations: "disabled" });
    await panel.getByRole("button", { name: "关闭", exact: true }).click();
    await page.clock.runFor(250); await panel.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), stored, "Reviewing preserves the accepted record unchanged");
    await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
  }, { width: 1280, height: 900, theme: "dark", record: JSON.stringify(accepted) });

  for (const scenario of [{ width: 375, height: 812 }, { width: 320, height: 694, large: true }, { width: 844, height: 390 }, { width: 1280, height: 900, theme: "dark" }]) {
    await run(`agreement-layout-focus-${scenario.width}`, async (page, { width, height }) => {
      await finishIntro(page); const panel = agreement(page); await panel.waitFor(); await gated(page);
      const heading = panel.getByRole("heading", { name: "使用条款与免责声明", exact: true });
      assert(await heading.evaluate(el => document.activeElement === el), "Agreement heading receives initial focus");
      if (width === 375) {
        assert.equal(await panel.getByRole("checkbox").isChecked(), false);
        assert.equal(await acceptButton(page).isEnabled(), false);
        await page.screenshot({ path: `${output}/agreement-375-initial-unchecked.png`, animations: "disabled" });
      }
      const card = panel.locator(".hg-agreement-card"), rect = await bounds(card); assert(inside(rect, width, height), "Agreement card fits viewport");
      assert.equal(await panel.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
      const checkbox = panel.getByRole("checkbox"); await checkbox.scrollIntoViewIfNeeded();
      assert(inside(await bounds(checkbox), width, height) && await actionable(checkbox)); await checkbox.check();
      const button = acceptButton(page); await button.scrollIntoViewIfNeeded();
      const actionRect = await bounds(button); assert(inside(actionRect, width, height) && await actionable(button));
      assert(actionRect.height >= 44);
      await button.focus(); await page.keyboard.press("Tab");
      assert(await panel.evaluate(el => el.contains(document.activeElement)), "Tab remains inside agreement");
      const body = panel.locator(".hg-agreement-scroll"); assert(await body.evaluate(el => document.activeElement === el), "Tab wraps to agreement text");
      await page.keyboard.press("Shift+Tab"); assert(await button.evaluate(el => document.activeElement === el), "Reverse Tab wraps to accept control");
      await button.scrollIntoViewIfNeeded(); report.measurements.push({ name: `layout-${width}`, card: rect, accept: await bounds(button) });
      await page.screenshot({ path: `${output}/agreement-${width}-actions.png`, animations: "disabled" });
    }, scenario);
  }
  assert.deepEqual(report.errors, [], "No browser exceptions");
  if (report.failed.length) process.exitCode = 1;
} catch (error) { report.failed.push({ name: "runner", error: String(error.stack || error) }); process.exitCode = 1; }
finally { await browser?.close(); await server?.close(); await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2)); console.log(`Disclaimer gate checks: ${report.passed.length} passed, ${report.failed.length} failed. Artifacts: ${output}`); }
