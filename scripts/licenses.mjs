#!/usr/bin/env node
// 오픈소스 라이선스 고지 만들기. 앱에 담기는 Rust 크레이트·화면(npm) 패키지·글꼴, 그리고 작업 기억이 내려받는
// 모델·ONNX Runtime 의 라이선스와 원문을 모아 src/generated/third-party-licenses.json 으로 쓴다.
// 의존성을 바꾸면 다시 돌린다: node scripts/licenses.mjs  (pnpm test 가 직접 의존성이 빠졌는지 확인한다)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "src/generated/third-party-licenses.json");
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;

function licenseTexts(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => LICENSE_FILE.test(n) && fs.statSync(path.join(dir, n)).isFile())
    .sort()
    .map((n) => fs.readFileSync(path.join(dir, n), "utf8"));
}

/** 앱(ai-terminal)에서 일반 의존성으로 닿는 크레이트. 두 아키텍처를 합치고 개발용·빌드용은 뺀다. */
function rustPackages() {
  const out = new Map();
  for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
    const meta = JSON.parse(
      execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--filter-platform", target], { cwd: path.join(root, "src-tauri"), maxBuffer: 1 << 28 }).toString(),
    );
    const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
    const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
    const rootId = meta.resolve.root;
    const seen = new Set([rootId]);
    const stack = [rootId];
    while (stack.length) {
      for (const d of nodes.get(stack.pop()).deps) {
        if (!d.dep_kinds.some((k) => k.kind === null) || seen.has(d.pkg)) continue;
        seen.add(d.pkg);
        stack.push(d.pkg);
      }
    }
    seen.delete(rootId);
    for (const id of seen) {
      const p = pkgs.get(id);
      const key = `${p.name}@${p.version}`;
      if (out.has(key)) continue;
      const dir = path.dirname(p.manifest_path);
      const texts = p.license_file ? [fs.readFileSync(path.join(dir, p.license_file), "utf8")] : licenseTexts(dir);
      out.set(key, { name: p.name, version: p.version, license: p.license ?? "", url: p.repository ?? p.homepage ?? "", kind: "rust", texts, authors: p.authors ?? [] });
    }
  }
  return [...out.values()];
}

/** 화면에 묶여 들어가는 npm 패키지(개발용 제외) */
function npmPackages() {
  const d = JSON.parse(execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], { cwd: root, maxBuffer: 1 << 26 }).toString());
  const out = [];
  for (const [license, list] of Object.entries(d)) {
    for (const p of list) {
      p.versions.forEach((v, i) => {
        out.push({ name: p.name, version: v, license: license === "Unknown" ? "" : license, url: p.homepage ?? "", kind: "npm", texts: licenseTexts(p.paths[i] ?? p.paths[0]) });
      });
    }
  }
  return out;
}

const MIT = (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const rust = rustPackages();
const npm = npmPackages();
// npm 쪽 정보가 비어 있으면 같은 이름의 Rust 크레이트(같은 프로젝트) 것을 쓴다(예: @crabnebula/tauri-plugin-drag)
for (const p of npm.filter((x) => !x.license || !x.texts.length)) {
  const twin = rust.find((r) => r.name === p.name.replace(/^@[^/]+\//, ""));
  if (twin) {
    p.license ||= twin.license;
    if (!p.texts.length) p.texts = twin.texts;
    p.url ||= twin.url;
  }
}
const BSD3 = (holder) => `Copyright (c) ${holder}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`;
// 원문 파일을 함께 내지 않은 크레이트: 고를 수 있으면 MIT, 아니면 그 라이선스의 표준 원문(저작권자 = Cargo.toml 의 authors)
for (const p of rust.filter((r) => !r.texts.length)) {
  const holder = p.authors.map((a) => a.replace(/\s*<[^>]*>/, "")).join(", ") || `${p.name} authors`;
  if (/\bMIT\b/.test(p.license)) p.texts = [MIT(holder)];
  else if (/BSD-3-Clause/.test(p.license)) p.texts = [BSD3(holder)];
  else if (/MPL-2\.0/.test(p.license))
    p.texts = [`This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.\nIf a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.\nSource code: ${p.url}`];
}
const apache = rust.flatMap((r) => r.texts).find((t) => /Apache License\s+Version 2\.0, January 2004/.test(t) && t.length > 9000);
const extra = [
  { name: "Haengbang Mono (D2Coding 1.3.2 기반 터미널 글꼴)", version: "", license: "OFL-1.1", url: "https://github.com/naver/d2codingfont", kind: "font", texts: [fs.readFileSync(path.join(root, "src/assets/fonts/HaengbangMono-OFL.txt"), "utf8")] },
  { name: "EmbeddingGemma 2 (작업 기억을 켜면 내려받음)", version: "onnx-community@daa72c5", license: "Apache-2.0", url: "https://huggingface.co/google/embeddinggemma-2", kind: "download", texts: apache ? [apache] : [] },
  { name: "ONNX Runtime (작업 기억을 켜면 내려받음)", version: "1.31.1", license: "MIT", url: "https://github.com/microsoft/onnxruntime", kind: "download", texts: [MIT("Microsoft Corporation")] },
];

// 같은 원문은 한 번만 싣는다(줄바꿈·줄 끝 공백만 다른 것도 같게 본다)
const texts = [];
const index = new Map();
const idOf = (t) => {
  const norm = t.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  const h = createHash("sha256").update(norm).digest("hex");
  if (!index.has(h)) {
    index.set(h, texts.length);
    texts.push(norm);
  }
  return index.get(h);
};
const packages = [...rust, ...npm, ...extra]
  .map((p) => ({ name: p.name, version: p.version, license: p.license || "?", url: p.url, kind: p.kind, texts: p.texts.map(idOf) }))
  .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ packages, texts }) + "\n");
const noText = packages.filter((p) => !p.texts.length);
console.log(`${packages.length}개 (Rust ${rust.length}, npm ${npm.length}, 기타 ${extra.length}), 원문 ${texts.length}개, ${(fs.statSync(OUT).size / 1024).toFixed(0)}KB → ${path.relative(root, OUT)}`);
if (noText.length) console.log(`원문 파일이 없는 것 ${noText.length}개: ${noText.map((p) => `${p.name}@${p.version}(${p.license})`).join(", ")}`);
