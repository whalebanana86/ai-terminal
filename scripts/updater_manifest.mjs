// Both Mac architectures use the same signed universal app archive.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function manifest(version, signature, repository, notes = "") {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid release version");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid GitHub repository");
  if (!signature.trim()) throw new Error("Missing update signature");
  const artifact = {
    url: `https://github.com/${repository}/releases/download/v${version}/Code-Whereabouts-${version}-macOS.app.tar.gz`,
    signature: signature.trim(),
  };
  return { version, notes, platforms: { "darwin-aarch64": artifact, "darwin-x86_64": artifact } };
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const [version, out, repo] = process.argv.slice(2);
  const signature = readFileSync(join(out, `Code-Whereabouts-${version}-macOS.app.tar.gz.sig`), "utf8");
  let notes = "";
  try { notes = readFileSync(`docs/release-notes/${version}.md`, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  writeFileSync(join(out, "latest.json"), JSON.stringify(manifest(version, signature, repo, notes), null, 2) + "\n");
}
