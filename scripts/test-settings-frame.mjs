// Setting headings, content and reveal effects share a single card boundary.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { installFixture } from './fixtures/app-ui.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(new URL(`../test-results/settings-frame/${Date.now()}/`, import.meta.url));
await mkdir(output, { recursive: true });
const report = { environment: 'Real App/Settings in Chromium with neutral offline IPC; no native-device claim', passed: [], failed: [], errors: [], measurements: [] };
const titles = ['外观', '播放', '内容偏好', '本地数据', '网络', '播放诊断', '其他'];
let server, browser;
try {
  server = await createServer({ root, server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  for (const scenario of [
    { width: 375, height: 812, theme: 'light' },
    { width: 375, height: 812, theme: 'dark' },
    { width: 1280, height: 900, theme: 'dark' },
    { width: 320, height: 694, theme: 'light', largeText: true },
  ]) {
    const { width, height, theme, largeText } = scenario;
    const name = `${width}x${height}-${theme}${largeText ? '-24px' : ''}`;
    if (process.env.SETTINGS_FRAME_CASE && process.env.SETTINGS_FRAME_CASE !== name) continue;
    const mobile = width < 1024;
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce',
      ...(mobile ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', isMobile: true, hasTouch: true } : {}) });
    await context.addInitScript(installFixture, { theme, titles: ['界面测试'] });
    await context.addInitScript(() => {
      localStorage.setItem('hghubx_auto_line', 'off');
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
        if (command === 'line_state') return { base: 'https://fixture.invalid', fixed: [], custom: false };
        if (command === 'proxy_state') return { mode: 'system', url: '', effective: null };
        if (command === 'playback_log_status') return { enabled: false, path: '/fixture/logs/playback.log', error: null };
        return invoke(command, args);
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6500);
    page.on('pageerror', error => report.errors.push(`${name}: ${error.message}`));
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort());
    try {
      await page.goto(origin);
      if (mobile) await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的', exact: true }).click();
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '外观设置', exact: true }).waitFor();
      if (largeText) await page.addStyleTag({ content: '.ios-settings-content :is(h2,h3,p,label,span,button,input,summary) { font-size:24px !important; }' });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      assert.equal(await page.locator('.ios-settings-frame').count(), 7, 'Each settings group must own a visible frame around its heading and panel');
      for (const title of titles) {
        const section = page.locator(`[id="settings-${title}"]`);
        const frame = section.locator('.ios-settings-frame');
        const trigger = section.getByRole('button', { name: `${title}设置`, exact: true });
        assert.equal(await trigger.getAttribute('aria-expanded'), 'false', `${title}: default collapsed`);
        assert.equal(await frame.locator('.ios-settings-heading').count(), 1, `${title}: title is a descendant of its card`);
        assert.equal(await frame.locator('.ios-settings-panel').count(), 1, `${title}: panel shares that same card`);
        assert.equal(await section.locator('.ios-setting-group').count(), 1, `${title}: heading and content use one shared material frame`);
        const geometry = await frame.evaluate(el => {
          const box = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
          return { frame: box(el), title: box(el.querySelector('.ios-settings-title')), summary: box(el.querySelector('.ios-settings-summary')), overflow: el.scrollWidth > el.clientWidth + 1 };
        });
        for (const label of ['title', 'summary']) {
          const text = geometry[label], card = geometry.frame;
          assert(text.left >= card.left + 12 && text.right <= card.right - 12, `${title} ${label}: inset within frame`);
          assert(text.top >= card.top && text.bottom <= card.bottom, `${title} ${label}: vertically inside frame`);
        }
        assert(!geometry.overflow, `${title}: text stays within card width`);
        report.measurements.push({ name, title, ...geometry });
      }
      await page.screenshot({ path: `${output}/${name}-collapsed.png`, animations: 'disabled' });
      const appearance = page.locator('#settings-外观');
      await appearance.getByRole('button', { name: '外观设置', exact: true }).click();
      const effect = await appearance.locator('.ios-settings-frame').evaluate(el => {
        const effect = getComputedStyle(el, '::after'), card = el.getBoundingClientRect();
        const heading = el.querySelector('h2').getBoundingClientRect(), panel = el.querySelector('.ios-settings-panel').getBoundingClientRect();
        for (const animation of el.getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = 250; }
        return { open: el.dataset.open, after: { content: effect.content, animation: effect.animationName, top: effect.top, right: effect.right, bottom: effect.bottom, left: effect.left, radius: effect.borderRadius, z: effect.zIndex, pointer: effect.pointerEvents },
          radius: getComputedStyle(el).borderRadius, headerInside: heading.top >= card.top && heading.bottom <= card.bottom, panelInside: panel.top >= card.top && panel.bottom <= card.bottom,
          panelEffect: getComputedStyle(el.querySelector('.ios-settings-panel'), '::after').content };
      });
      assert.equal(effect.open, 'true');
      assert.notEqual(effect.after.content, 'none', 'Frame owns reveal effect');
      assert.notEqual(effect.after.animation, 'none', 'Normal motion animates reveal');
      assert.deepEqual([effect.after.top, effect.after.right, effect.after.bottom, effect.after.left], ['0px', '0px', '0px', '0px'], 'Reveal fills whole frame including heading');
      assert.equal(effect.after.radius, effect.radius, 'Glow clips to actual card radius');
      assert.equal(effect.after.z, '0', 'Reveal sits below text and controls');
      assert.equal(effect.after.pointer, 'none');
      assert(effect.headerInside && effect.panelInside, 'Expanded heading and panel remain in card');
      assert(['none', 'normal'].includes(effect.panelEffect), 'Panel no longer paints a separate glow boundary');
      await page.screenshot({ path: `${output}/${name}-expanded-effect.png` });
      await page.evaluate(() => document.getAnimations().forEach(animation => animation.finish()));
      const preferences = page.locator('#settings-内容偏好');
      const trigger = preferences.getByRole('button', { name: '内容偏好设置', exact: true });
      await trigger.click();
      const input = preferences.getByRole('textbox', { name: '添加屏蔽标签', exact: true });
      await input.fill('保留编辑中的草稿');
      await trigger.click();
      assert.equal(await input.isVisible(), false);
      await trigger.click();
      assert.equal(await input.inputValue(), '保留编辑中的草稿');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await trigger.click(); await trigger.click();
      assert.equal(await preferences.locator('.ios-settings-frame').evaluate(el => getComputedStyle(el, '::after').animationName), 'none', 'Reduced motion removes glow');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal viewport overflow');
      report.passed.push(name);
      console.log(`PASS ${name}`);
    } catch (error) {
      report.failed.push({ name, error: String(error.stack || error) });
      console.error(`FAIL ${name}: ${error.message}`);
      await page.screenshot({ path: `${output}/${name}-failure.png`, animations: 'disabled' }).catch(() => {});
    } finally { await context.close(); }
  }
  assert.deepEqual(report.errors, [], 'No browser errors');
  if (report.failed.length) process.exitCode = 1;
} catch (error) { report.failed.push({ name: 'runner', error: String(error.stack || error) }); process.exitCode = 1; }
finally {
  await browser?.close(); await server?.close();
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(`Settings frame checks: ${report.passed.length} passed, ${report.failed.length} failed. Artifacts: ${output}`);
}
