#!/usr/bin/env bash
# 자동 검증·수정 루프(AGENTS.md 3번) 실행 입구. 빌드·타입 검사·Lint·테스트를 돌리고 시도 내역을
# .agent/attempts/<TASK-ID>.jsonl 에 남긴다. 규칙·종료 코드는 scripts/auto-fix-loop.mjs 머리말.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/auto-fix-loop.mjs "$@"
