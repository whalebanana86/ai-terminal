# 요청마다 모델을 고르는 터미널 / Request-routing terminal

코드행방 **앱 안에서는 설치할 필요가 없습니다**. 새 세션 → Codex → 자동 선택 터미널을 고르면 같은 실행 엔진으로 요청마다 모델을 자동 선택합니다. 아래 `codewhere` 명령은 앱 밖의 셸에서도 쓰고 싶은 경우에만 설치합니다.

**No installation is needed inside the app.** Choose New Session → Codex → Auto-select terminal. The standalone `codewhere` command below is optional for shells outside the app.

`codewhere`는 Codex CLI 앞에서 요청을 받고 모델을 지정하는 공용 실행기입니다. 기존 Codex TUI 입력을 가로채지 않습니다. Python 3.9+, Git, 로그인된 Codex CLI가 필요합니다. 추가 Python 패키지나 API 키는 필요하지 않습니다. 현재 Codex CLI의 `exec --json`과 `exec resume --model`을 사용합니다.

`codewhere` receives requests before invoking Codex, rather than intercepting an existing Codex TUI. Requires Python 3.9+, Git and an authenticated Codex CLI. No extra Python packages or API key are required. Uses `exec --json` and `exec resume --model`.

## 설치 / Install

코드행방 저장소에서 한 번 실행합니다. / Run once from the Code Whereabouts checkout:

```sh
python3 scripts/install_cli.py
```

실행 파일은 `~/.local/share/code-whereabouts/cli`, 명령 링크는 `~/.local/bin/codewhere`에 설치합니다. `~/.local/bin`이 PATH에 있으면 모든 저장소에서 사용할 수 있습니다. 설치 후 이 저장소를 옮겨도 작동합니다. 업데이트도 같은 설치 명령을 사용합니다. 셸 설정이나 `~/.codex/config.toml`을 수정하지 않습니다.

Installs independent files in `~/.local/share/code-whereabouts/cli` and a command link in `~/.local/bin/codewhere`. Add `~/.local/bin` to PATH if needed. Moving the source checkout does not break the installation. Run the installer again to update; it does not modify shell or Codex configuration.

## 사용 / Usage

```sh
cd /path/to/your/repository
codewhere                        # 대화형 / Interactive
codewhere "로그인 버튼 기능 추가"   # 한 번 요청 / One request
codewhere "동시성 오류 조사"       # 같은 세션, 새 모델 선택 / Same session, reselect model
codewhere "계속해"                 # 직전 난이도 유지 / Keep previous task category
codewhere --dry-run "git pull"    # 실행 없이 선택 확인 / Preview without inference
codewhere --mode complex "오류 조사" # 직접 선택 / Manual override
codewhere --status               # 세션 확인 / Session info
codewhere --new "새로운 작업"      # 새 대화 / New conversation
codewhere --session review "변경 검토" # 별도 대화 / Separate named conversation
codewhere --sandbox read-only "코드 조사" # 읽기 전용 / Read-only
printf '%s\n' '첫 번째 줄' '두 번째 줄' | codewhere
```

대화형 명령 / Interactive commands:

- `/model auto|simple|general|complex`: 자동·수동 선택 / Automatic or manual model selection.
- `/paste`: 여러 줄 입력. `.`만 입력한 줄로 마칩니다. / Multiline input; finish with a line containing only `.`.
- `/status`: 현재 세션 / Current session.
- `/new`: 새 대화. 기존 Codex 기록은 삭제하지 않습니다. / New conversation without deleting Codex history.
- `/help`, `/exit`: 도움말·종료 / Help and exit.
- Ctrl+C: 현재 요청 취소 후 다시 입력 / Cancel current request and return to the prompt.

## 선택과 세션 / Selection and sessions

| 요청 / Task | 모델 / Model | 추론 강도 / Effort |
|---|---|---|
| 단순 / Simple | GPT-6 Luna | Low |
| 일반 개발 / General development | GPT-6.1 Sol | Low |
| 복잡한 개발 / Complex development | GPT-6.1 Sol | Medium |

앱과 `scripts/codex-routing.json`의 키워드 규칙을 공유하며 분류 API는 호출하지 않습니다. 애매한 요청은 일반 개발로 분류합니다. 짧은 이어가기 요청은 직전 분류를 유지하며, 명시적인 새 요청은 다시 분류합니다. 문구 기반이라 정확하지 않을 수 있고 `--mode` 또는 `/model`로 바꿀 수 있습니다.

Shares local keyword rules with the app in `scripts/codex-routing.json`. Ambiguous requests default to general development. Short continuations retain the previous category; explicit new requests are reclassified. Use `--mode` or `/model` to correct a heuristic classification.

저장소 루트(실제 경로)와 `--session` 이름으로 세션 ID를 저장합니다. 같은 저장소의 하위 폴더는 같은 대화를 사용하고, 별도 워크트리는 별도 대화를 사용합니다. 실행 폴더는 저장소/워크트리 루트입니다. `--last`로 다른 작업의 대화를 가져오지 않고 명시적인 ID로 이어갑니다. 기본 상태 경로는 `~/.local/state/code-whereabouts`이며 요청·출력·토큰은 이 상태 파일에 저장하지 않습니다. Codex 자체 기록은 Codex가 관리합니다. 같은 대화의 요청은 한 번에 하나만 실행합니다. 다른 이름으로 병렬 실행할 경우 파일 충돌을 피하려면 별도 워크트리를 사용하세요.

Session IDs are scoped to the canonical Git worktree root and conversation name. Subfolders share the same conversation, linked worktrees do not. Commands run from the worktree root. Resumes use explicit IDs, never `--last`. Router state is stored in `~/.local/state/code-whereabouts` without prompts, output or credentials; Codex manages its own history. One request per conversation may run at a time. Use separate worktrees if running different named conversations concurrently against changing files.

기본 샌드박스는 `workspace-write`이며 승인 우회 옵션을 넣지 않습니다. 비대화형 `codex exec`의 승인 처리에 따라 추가 허락이 필요한 작업은 실패할 수 있습니다. 실패하면 오류를 표시하고 같은 세션을 보존하며 다른 모델로 재시도하지 않습니다. 기본 Codex 명령과 앱 원본 터미널 동작은 유지됩니다.

Defaults to `workspace-write`, without approval bypass flags. Operations needing additional approval can fail under non-interactive `codex exec`. Errors retain the session without retrying on another model. The ordinary `codex` command and the app's original terminal remain available.

공식 CLI 동작 / Official CLI behavior: [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [CLI reference](https://learn.chatgpt.com/docs/cli/reference).

## 검증 / Tests

```sh
python3 -B -m unittest discover -s scripts -p 'test_codewhere.py' -v
```

모델 인자, 세션 이어가기, 저장소·워크트리 분리, 실패·취소, 중복 실행 차단, 입력 전달, 대화형 입력과 설치를 가짜 CLI로 검증합니다. / Tests use a fake CLI to verify model arguments, session continuation, worktree isolation, errors, cancellation, concurrency locking, prompt transport, interactive input and installation.

테스트 전용 환경 변수 / Test environment overrides: `CODEWHERE_CODEX_BIN`, `CODEWHERE_STATE_DIR`.
