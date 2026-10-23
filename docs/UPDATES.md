# 업데이트 배포

앱 메뉴의 명시적인 확인에서만 GitHub Releases API에 접속한다. 정식 최신 릴리즈를 semver로 비교하고, 같은 버전·이전 버전·사전 공개 버전은 설치하지 않는다. `latest.json`이 없는 기존 릴리즈는 다운로드 페이지로 안내한다. API 제한·연결 오류·서명 오류는 실패로 표시하며 최신 버전으로 간주하지 않는다.

## 서명 키

공개 키는 `src-tauri/tauri.conf.json`에 포함되어 있다. 이에 대응하는 개인 키는 이 기능을 구성한 맥의 `~/.tauri/ai-terminal-updater.key`에 생성했으며 권한은 600이다. 저장소에 커밋하지 않는다. 이 키를 안전하게 백업하고 다음 GitHub Actions secrets를 설정한다.

- `TAURI_SIGNING_PRIVATE_KEY`: 개인 키 파일의 내용
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: 암호를 설정했다면 그 암호 (현재 생성한 키는 빈 암호)

메뉴가 있는 앱을 배포한 뒤 공개 키를 바꾸면 이미 설치된 앱은 새 서명을 신뢰하지 못한다. 이 키를 유지해야 한다. Developer ID와 Apple 공증 키는 업데이트 서명 키와 별개다.

## 배포와 로컬 패키징

태그 배포 워크플로는 서명 secret이 없으면 초기에 실패하며, secret을 패키징 스크립트에 전달한다. 모든 배포 파일 업로드가 성공한 뒤 초안 릴리즈를 공개한다. secret이 있으면 최종 서명된 universal 앱으로 `.app.tar.gz`를 만들고 `tauri signer sign --app-version`으로 서명한 다음 두 Mac 아키텍처에 대한 `latest.json`을 생성한다. 키가 없으면 명시적으로 DMG·zip만 배포하고 앱은 다운로드 페이지로 안내한다.

로컬에서는 다음과 같이 실행한다.

```bash
TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.tauri/ai-terminal-updater.key" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD='' scripts/package_release.sh 0.3.0
```

배포 산출물은 `build/release/`에 있다. 공개 릴리즈에는 DMG·zip과 함께 `latest.json`, `.app.tar.gz`, `.app.tar.gz.sig`를 올린다. 태그는 `v<버전>` 형식이다. 서명에는 버전을 포함하며 앱에서 `requireSignedVersion`을 켜 두어 manifest의 버전과 일치해야 설치한다.

## 실행 중 작업 보호

실행 중인 PTY는 새 앱으로 넘겨 에이전트 작업을 이어간다. 서명 검증 실패 시 기존 앱을 교체하지 않는다. 앱 밖에서 실행 중인 CLI는 업데이트 때문에 종료하지 않는다.

## 서비스명 변경

한국어 이름은 **코드행방**, 부제는 **AI가 어디서 무엇을 바꾸는지**다. 영어 이름은 **Code Whereabouts**, 부제는 **See where AI works and what it changes**다. 화면·창 제목·앱 메뉴·정보 창은 앱의 언어 설정을 따른다. Finder·Dock 표시 이름에는 macOS의 언어 선택을 따른 `InfoPlist.strings`를 포함한다.

앱 번들은 `코드행방.app`, 새 배포 파일은 `Code-Whereabouts-<버전>-macOS.*`다. 기존 `dev.aiterminal.app` 식별자, `ai-terminal.sqlite3`, localStorage 키, GitHub 저장소 URL과 업데이트 서명 키는 호환성을 위해 유지한다. 설치 스크립트는 기존 `AI Terminal.app`을 새 이름으로 옮기며 실행 중인 에이전트를 강제로 종료하지 않는다.
