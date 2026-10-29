// 소개 영상 그리기(헤드리스 크롬, playwright-core).
//   node render.mjs shot <화면구조.html> <out.png> [base]    앱 화면 구조를 1440×900 의 2배로 그림
//   node render.mjs fontshot <fontcompare.html> <out.png>     터미널 글꼴 비교
//   node render.mjs stills <timeline.html> <폴더> <시각,…>    미리보기 몇 장
//   node render.mjs frames <timeline.html> <폴더> <초> <fps>   타임라인을 1920×1080 프레임으로
// PW_DIR: playwright-core 가 설치된 폴더, CHROME: 크롬 실행 파일
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve("playwright-core", { paths: [process.env.PW_DIR ?? process.cwd()] }));
const [mode, input, out, a, b] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--disable-background-timer-throttling", "--font-render-hinting=none"] });

if (mode === "shot") {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  let html = readFileSync(input, "utf8").replace(/<script\b[\s\S]*?<\/script>/g, "");
  // 빌드한 화면을 띄운 서버에서 글꼴·그림·스타일 경로가 풀리게(앱 안 주소 tauri://localhost/ 도 바꾼다)
  if (a) html = html.replace(/tauri:\/\/localhost\//g, a).replace(/<head>/i, `<head><base href="${a}">`);
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  // 화면 구조에는 스크롤 위치가 없다: 장면에서 data-promo-scroll 로 적어 둔 위치로 되돌린다
  await page.evaluate(() => document.querySelectorAll("[data-promo-scroll]").forEach((e) => (e.scrollTop = Number(e.dataset.promoScroll))));
  await page.waitForTimeout(300);
  await page.screenshot({ path: out });
} else if (mode === "fontshot") {
  const page = await browser.newPage({ viewport: { width: 1600, height: 390 }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(input).href);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 20000 });
  await page.screenshot({ path: out });
} else if (mode === "stills") {
  // 미리보기: a = "1.0,5.5,9" 처럼 쉼표로 이은 시각들
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(input).href);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 20000 });
  mkdirSync(out, { recursive: true });
  for (const t of a.split(",").map(Number)) {
    await page.evaluate((x) => window.render(x), t);
    await page.screenshot({ path: `${out}/t${t.toFixed(1)}.png` });
  }
} else if (mode === "frames") {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(input).href);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 20000 });
  mkdirSync(out, { recursive: true });
  const secs = Number(a), fps = Number(b);
  const n = Math.round(secs * fps);
  for (let i = 0; i < n; i++) {
    await page.evaluate((t) => window.render(t), i / fps);
    await page.screenshot({ path: `${out}/f${String(i).padStart(5, "0")}.png` });
    if (i % 60 === 0) process.stdout.write(`\r  ${i}/${n}`);
  }
  process.stdout.write(`\r  ${n}/${n}\n`);
}
await browser.close();
