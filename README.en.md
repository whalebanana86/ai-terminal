# Code Whereabouts

**See where AI works and what it changes**

Formerly AI Terminal. Existing repositories and session settings are preserved. Older releases may still use the `AI-Terminal-…` filename. The app bundle is `코드행방.app`; macOS uses the localized display name **Code Whereabouts** in English.

[한국어](README.md) · **English**

<p align="center">
  <img src="docs/demo.gif" width="900" alt="30-second demo: pick a session → all three panes follow its worktree → file diff and image compare → continue in chat with a tool permission card → stage part of a file → graph menu → worktrees">
  <br><sub>30-second demo (<a href="docs/demo.mp4">MP4</a>) · recorded with made-up sample data</sub>
</p>

<p align="center">
  <a href="https://github.com/whalebanana86/ai-terminal/releases/latest"><b>⬇︎ Download (macOS 12+, Apple silicon & Intel)</b></a>
</p>

A macOS app for people who run **several Claude Code and Codex sessions at once**. It shows **which repository, worktree and branch** each AI session is working in, lets you continue any session, and keeps Git and the files on the same screen.

## What is it?

You can now ask an AI to "build the login screen" or "fix this bug". Once you have two or three of them running in different folders and branches, it gets confusing fast.

Code Whereabouts splits the window into three panes:

- the **middle** collects your AI conversations (sessions),
- picking one moves the **left (Git)** and **right (files)** panes to the worktree that session was working in,
- and one button **continues** that conversation.

![Three panes: Git graph on the left, sessions and the conversation in the middle, files on the right](docs/screenshots/overview.png)

> Every picture in this README was made from invented sample data (a to-do app repository, made-up names). `scripts/make_screenshots.sh` regenerates them.

## Why?

1. **"Which branch is that agent on right now?"** Each agent works in its own worktree and branch, and a terminal tab doesn't tell you. Switch the branch by mistake and the agent suddenly sees different files.
2. **Conversations are scattered.** Several terminal tabs, other apps, yesterday's closed ones. Continuing means hunting for a session id and typing the command.
3. **Seeing what the AI changed needs yet another app.** A Git client for the diff, an editor for the files.

So Code Whereabouts

- lists your local Claude Code and Codex conversations **per repository and worktree**,
- moves the Git and file panes to the session's worktree **without ever checking anything out** (only the view changes),
- and continues a conversation with one button, either in the original CLI or in the app's chat view.

## Install

**Easiest:** download `Code-Whereabouts-…-macOS.dmg` from [Releases](https://github.com/whalebanana86/ai-terminal/releases/latest), open it and drag **Code Whereabouts** to Applications. It is not notarized yet, so the first launch may need **System Settings → Privacy & Security → Open Anyway** (or `xattr -dr com.apple.quarantine "/Applications/코드행방.app"`).

**Build it yourself:** about ten minutes the first time (Rust compiles a lot).

### Requirements

- macOS 12+ on Apple silicon. Intel Macs are untested
- `git` (`xcode-select --install`)
- [Rust](https://rustup.rs), [Node.js](https://nodejs.org) 20+ and [pnpm](https://pnpm.io)
- At least one AI CLI **already logged in**: [Claude Code](https://code.claude.com) (`claude`) or [Codex CLI](https://github.com/openai/codex) (`codex`)

### Steps

```bash
git clone https://github.com/whalebanana86/ai-terminal.git
cd ai-terminal
pnpm install          # also builds the app and puts it in /Applications
open "/Applications/코드행방.app"
```

`pnpm install-app` rebuilds just the app; `AITERM_SKIP_APP=1 pnpm install` skips it.

Then use **＋ 저장소 추가** (Add repository) at the top to pick a Git repository. Repositories you have used with an AI are found automatically.

> A `dmg` built by someone else is not notarized yet. If macOS blocks it, use **System Settings → Privacy & Security → Open Anyway**, or run `xattr -dr com.apple.quarantine "/Applications/코드행방.app"`. Apps you build yourself are fine.

**Update:** `git pull && pnpm install` replaces the app (quit and reopen it if it was running). **Uninstall:** delete the app, and `~/Library/Application Support/dev.aiterminal.app` if you also want to forget the repository list. Your AI conversation logs are not created by this app and stay where they are.

## Using it

| Pane | Shows |
|---|---|
| Left — **Git** | Commit graph drawn like a metro map (one colour per worktree), worktrees, changes and commit, branches |
| Middle — **Agents** | Conversations that worked in the current worktree (today, yesterday, this week…), the selected conversation, Continue |
| Right — **Files** | The worktree's real files with M/U/D marks; click for content, diff or image |

The coloured line under the title bar is the colour of the worktree you are looking at. Graph lines, the worktree list and the file pane header use the same colour, so you always know where you are.

### Picking a session moves all three panes

![Selecting the login session moves Git and files to the todo-app-login worktree](docs/screenshots/worktree-switch.png)

- The left and right panes follow the session's worktree. Nothing is checked out; only the view changes.
- If the branch at the start of the session differs from the current branch, it shows `feature/tags → main`.
- Sessions currently open outside the app (another terminal, the Codex app…) are marked "running in Terminal", and opening them here asks first.

### Continuing a conversation

![Chat view: the agent asks permission to run the tests](docs/screenshots/chat.png)

- **Continue (이어가기)**, with ▾ to choose how:
  - **Chat view** — before the agent runs a command or edits a file, it shows the **actual command or content as a card** and waits for Allow/Deny. Choose the permission scope (ask for each tool, auto-allow file edits, plan only).
  - **Original CLI terminal** — the real `claude` / `codex` UI inside the app, with your slash commands, login and subscription.
- **＋ New session** (`⌘N`) starts a new agent in the worktree you choose, optionally with a first instruction, or in a brand-new worktree so it doesn't collide with other agents.
- Run several at once; switching sessions doesn't stop running agents.

<img src="docs/screenshots/new-session.png" width="49%" alt="New session dialog"> <img src="docs/screenshots/worktrees.png" width="49%" alt="Worktrees tab with one colour per worktree">

### Git: review and commit only part of a change

![Changes tab: click a file to stage individual hunks below the list](docs/screenshots/stage.png)

- In **Changes**, `＋` stages a file. Click the file name to stage, unstage or discard **individual hunks** right below the list.
- Commits include **only what you staged**, with a preview of the files above the button.
- Right-click a commit in the graph for new branch / new worktree, and a submenu per branch for switch, merge and rebase. Conflicts get a banner where you pick a side per file or mark it resolved.
- Remote actions (fetch, pull with fast-forward only, push) always ask for confirmation.

![Graph context menu with a branch submenu](docs/screenshots/graph-menu.png)

### Files: content, diff and images

![Image file: last commit and current version side by side](docs/screenshots/image.png)

- File-type icons (TypeScript, Rust, images, config, README…).
- Content with syntax highlighting, diff against the last commit, or stage parts.
- Images (png, jpg, gif, webp, svg…) are shown as images; a changed image is shown **next to its last committed version**. Click to toggle actual size.
- Everything refreshes when an agent or editor changes files.

| Key | Action |
|---|---|
| `⌘N` | New session |
| `⌘R` | Reload sessions, repositories and Git |
| `⌘[` / `⌘]` | Previous / next session |
| `⌘1` `⌘2` `⌘3` | Focus Git / Agents / Files |
| `⌘⏎` | Commit (in the message box), Start (in the new-session dialog) |
| `⌘,` | Settings (language, appearance) |

## Privacy

- No account. Choosing Check for Updates contacts GitHub for release metadata and update files. No repository paths or conversation contents are sent (the UI remains locked down by CSP).
- Claude Code and Codex logs are **read only**.
- The only traffic is what you start: Git remote actions, and the Claude Code / Codex CLIs you launch.
- Hard-to-undo actions (checkout, pull, push, discard) always confirm, and warn about uncommitted changes or agents running in that worktree.

---

## Details for developers

- **Stack:** Tauri 2 (Rust) + React + TypeScript, xterm.js (WebGL), Shiki (languages loaded on demand), the `git` CLI (your credentials and hooks as is), portable-pty, notify, SQLite for app state (no conversation content).
- **Model:** Repository → Worktree → Branch/HEAD, linked to AgentSession (a CLI conversation) and AgentExecution (one run started by the app). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Logs read:** `~/.claude/projects/*/<id>.jsonl`, `~/.claude/sessions/<pid>.json`, `~/.codex/state_*.sqlite` (read-only), `~/.codex/sessions/**/rollout-*.jsonl[.zst]`, `~/.codex/thread-writer-locks/`. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honoured.
- **Linking a session to a worktree:** the last recorded cwd wins (resume always runs in the first cwd, because `claude --resume` looks up the log by its starting folder). Sessions started in a parent folder that is not a repository are linked to the repository folder they worked in most recently (from the cwd values in the last 2 MB of the log). Running sessions are detected with libproc, without spawning `ps` or `lsof`.
- **Commands:** `claude --resume <id>`, `codex resume <id> -C <cwd>`; chat uses `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompts host --permission-prompt-tool stdio` and answers `can_use_tool` requests with the CLI's own input; Codex chat runs `codex exec --json` per turn.
- **Security:** every Git/file command only accepts paths inside a registered worktree (`..`, absolute paths and symlinks pointing outside are refused). The automation socket used by tests exists only in `--features automation` builds.
- **Footprint:** CPU while an agent works 3.14% → 0.74%, memory 194 → 148 MB, session list 108 → 2 ms, UI bundle 11 MB → 3.5 MB; app 7.5 MB, dmg 3.8 MB.

```bash
pnpm tauri dev            # dev mode
pnpm check                # tsc + vitest + cargo test
AITERM_AUTOMATION_SOCKET=/tmp/aiterm-auto.sock pnpm tauri dev --features automation
scripts/e2e/regression.sh; scripts/e2e/features.sh; scripts/e2e/hangul.sh
scripts/make_screenshots.sh   # README images + demo video from sample data (needs ffmpeg)
scripts/package_release.sh 0.1.0   # universal app → build/release/ DMG, zip, SHA256SUMS (a v* tag does this on GitHub Actions and publishes a Release)
```

**Settings** (menu bar **Code Whereabouts → Settings…**, `⌘,`): language (한국어 / English, follows macOS at first) and appearance (system / light / dark; the terminal and code colours follow).

Not yet: notarized builds, Intel check, line-level staging, 3-way merge editor, interactive rebase, stash.

## License

MIT. Inspired by GitKraken's information layout; no GitKraken code or proprietary design is used. The commit-graph lane layout is our own implementation (vscode-git-graph and gitamine code is not used because of their licenses).

### Updates from the app menu

Choose **Code Whereabouts → Check for Updates…**. Signed releases can be downloaded, verified and installed in the app, then restarted. Stop terminal agents and wait for chat responses before installing. Older releases open the download page. GitHub is contacted only when you request an update; no repository paths or conversations are sent. See [docs/UPDATES.md](docs/UPDATES.md) for signing setup.
