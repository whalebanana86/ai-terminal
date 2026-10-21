#!/bin/bash
# 배포 파일 만들기: Apple 실리콘·인텔 겸용 앱 → build/release/ 에 DMG·zip·SHA256SUMS.txt
#
#   scripts/package_release.sh 0.1.0
#
# - 버전은 앱 정보(Info.plist)에 넣는다(tauri.conf.json 의 version 을 이번 빌드에만 덮어씀).
# - DMG 는 Finder 를 부르지 않고 hdiutil 로 만든다(Finder 스크립트는 화면이 잠겼거나 권한이 없으면 시간 초과로 실패한다).
# - SIGN_IDENTITY 가 있으면 그 인증서로 서명하고, APPLE_ID·APPLE_TEAM_ID·APPLE_APP_PASSWORD 가 있으면 공증까지 한다.
#   없으면 임시(ad-hoc) 서명.
set -euo pipefail
VERSION=${1:?버전을 주세요 (예: 0.1.0)}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "버전 꼴이 아니에요: $VERSION"; exit 1; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/build/release"
NAME="Code-Whereabouts-$VERSION-macOS"
TARGET=universal-apple-darwin
cd "$ROOT"

rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
CONFIG=$(printf '{"version":"%s"}' "$VERSION")
if [ -n "${SIGN_IDENTITY:-}" ]; then
  CONFIG=$(printf '{"version":"%s","bundle":{"macOS":{"signingIdentity":"%s"}}}' "$VERSION" "$SIGN_IDENTITY")
fi
pnpm tauri build --target "$TARGET" --bundles app --config "$CONFIG"

APP="$ROOT/src-tauri/target/$TARGET/release/bundle/macos/코드행방.app"
[ -d "$APP" ] || { echo "앱이 만들어지지 않았어요: $APP"; exit 1; }
lipo -archs "$APP/Contents/MacOS/ai-terminal"
# 겸용(universal) 실행 파일은 링커의 자동 서명이 빠져 있다. 서명 없는 앱은 Apple 실리콘에서 실행되지 않으므로
# 인증서가 없으면 임시(ad-hoc) 서명을 한다.
if [ -z "${SIGN_IDENTITY:-}" ]; then
  codesign --force --deep --sign - "$APP"
fi
codesign --verify --deep --strict "$APP"

rm -rf "$OUT"
mkdir -p "$OUT/dmg"
ditto "$APP" "$OUT/dmg/코드행방.app"
ln -s /Applications "$OUT/dmg/Applications"
hdiutil create -quiet -volname "코드행방" -srcfolder "$OUT/dmg" -fs HFS+ -format UDZO -ov "$OUT/$NAME.dmg"
rm -rf "$OUT/dmg"
ditto -c -k --keepParent "$APP" "$OUT/$NAME.zip"

if [ -n "${SIGN_IDENTITY:-}" ]; then
  codesign --force --sign "$SIGN_IDENTITY" --timestamp "$OUT/$NAME.dmg"
  if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ]; then
    xcrun notarytool submit "$OUT/$NAME.dmg" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait
    xcrun stapler staple "$OUT/$NAME.dmg"
  fi
fi

# Updater tarball is created after all app signing. Its signature also binds the version.
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]; then
  tar -czf "$OUT/$NAME.app.tar.gz" -C "$(dirname "$APP")" "코드행방.app"
  pnpm tauri signer sign --app-version "$VERSION" "$OUT/$NAME.app.tar.gz"
  node scripts/updater_manifest.mjs "$VERSION" "$OUT" "${GITHUB_REPOSITORY:-whalebanana86/ai-terminal}"
else
  echo "[release] 업데이트 서명 키 없음: DMG·zip 배포만 만듭니다. 자동 업데이트는 제공하지 않습니다."
fi
(
  cd "$OUT"
  files=("$NAME.dmg" "$NAME.zip")
  if [ -f latest.json ]; then
    files+=("$NAME.app.tar.gz" "$NAME.app.tar.gz.sig" latest.json)
  fi
  shasum -a 256 "${files[@]}" > SHA256SUMS.txt
)
ls -la "$OUT"
