import { test } from "vitest";
import assert from "node:assert/strict";
import { manifest } from "./updater_manifest.mjs";
test("signed universal artifact reaches both Mac architectures", () => {
  const result = manifest("0.2.10", "signature\n", "owner/repo", "Release notes");
  assert.equal(result.platforms["darwin-aarch64"].signature, "signature");
  assert.deepEqual(result.platforms["darwin-aarch64"], result.platforms["darwin-x86_64"]);
  assert.equal(result.platforms["darwin-x86_64"].url, "https://github.com/owner/repo/releases/download/v0.2.10/Code-Whereabouts-0.2.10-macOS.app.tar.gz");
});
test("rejects invalid versions, repositories and unsigned updates", () => {
  assert.throws(() => manifest("../../bad", "sig", "owner/repo"));
  assert.throws(() => manifest("0.2.2", "", "owner/repo"));
  assert.throws(() => manifest("0.2.2", "sig", "https://evil.example/repo"));
});
