// Post comment normalization: created_at supplies the missing display time,
// reply_list supplies the missing reply count, and supplied values stay intact.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "post-comment-time", new Date().toISOString().replace(/[:.]/g, "-"));
const report = { passed: [], external: [], pageErrors: [] };
await mkdir(output, { recursive: true });
let vite;
let browser;
let page;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  page.on("pageerror", (error) => report.pageErrors.push(error.message));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (new URL(url).origin === new URL(origin).origin) return route.continue();
    report.external.push(url);
    return route.abort();
  });

  await page.goto(`${origin}tests/post-comment-time.html`);
  await page.waitForFunction(() => window.commentTimeFixture);
  const normalized = await page.evaluate(() => window.commentTimeFixture);
  assert.equal(normalized.normalizedNoReplies.time, "1小时前");
  assert.equal(normalized.normalizedNoReplies.reply_count, 0);
  assert.equal(normalized.normalizedWithReplies.time, "3天前");
  assert.equal(normalized.normalizedWithReplies.reply_count, 2);
  assert.equal(
    normalized.malformedNumericTime,
    normalized.malformedNumericTimestamp,
    "An out-of-range numeric timestamp must not produce NaN-NaN-NaN",
  );
  report.passed.push("normalizeComment: relative time/reply count are filled and invalid numeric dates return the original text");

  await page.getByText("无回复用户", { exact: true }).waitFor();
  await page.getByText("1小时前", { exact: true }).waitFor();
  await page.getByText("3天前", { exact: true }).waitFor();
  await page.getByText("2 条回复", { exact: true }).waitFor();
  assert.equal(await page.getByText("0 条回复", { exact: true }).count(), 0);
  const body = await page.locator("body").innerText();
  assert.doesNotMatch(body, /undefined|null/, "Comment UI must not expose undefined/null text");
  report.passed.push("CommentsPanel: 吃瓜评论显示相对时间；无回复不显示计数，有回复显示 2 条");

  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.external, []);
  await page.screenshot({ path: join(output, "final.png"), fullPage: true });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = String(error.stack || error);
  await page?.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await vite?.close();
  console.log(`Artifacts: ${output}`);
}
