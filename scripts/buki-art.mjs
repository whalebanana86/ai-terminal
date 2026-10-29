// 부기 그림을 앱 밖(README·홍보)에 쓸 파일로 만든다. 픽셀 그림 원본은 src/buki.ts 하나.
//   node scripts/buki-art.mjs        → docs/buki.svg (README 맨 위)
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// TS 원본을 그대로 불러오려고 vite 를 빌려 쓴다(화면 서버는 띄우지 않음)
const vite = await createServer({ root, logLevel: "error", server: { middlewareMode: true, hmr: false }, appType: "custom", optimizeDeps: { noDiscovery: true } });
try {
  const { bukiSvg } = await vite.ssrLoadModule("/src/buki.ts");
  writeFileSync(join(root, "docs", "buki.svg"), bukiSvg({ px: 6 }) + "\n");
  console.log("docs/buki.svg");
} finally {
  await vite.close();
}
