"""PoC 용 기억 묶음: Claude·Codex 기록 → 턴 단위 조각(chunks.jsonl) + 턴 목록(turns.jsonl).
앱(sessions.rs)의 잡음 규칙을 따른다. 결과는 $WM_DIR/data 에만 쓴다(저장소 밖)."""
import glob, json, os, re, sys

OUT = os.path.join(os.environ.get("WM_DIR", "."), "data")
MAX = 400

CLAUDE_NOISE = ("<command-", "<local-command", "<system-reminder", "Caveat:", "[Request interrupted", "<bash-", "<task-notification")
CODEX_NOISE = ("<environment_context>", "<user_instructions>", "<permissions", "<skills_instructions>", "# AGENTS.md", "<turn_aborted>")
SECRET = re.compile(r"(sk-[A-Za-z0-9_\-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9\-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|npg_[A-Za-z0-9]{8,})")
# 접속 주소에 섞인 사용자:비밀번호
URL_CRED = re.compile(r"([a-z][a-z0-9+.\-]*://[^:/\s@]+:)[^@\s]+@")
PASTED = re.compile(r"<pasted_content[^>]*>(.*?)</pasted_content[^>]*>", re.S)


def clean(t):
    t = SECRET.sub("[가림]", t)
    t = URL_CRED.sub(lambda m: m.group(1) + "[가림]@", t)
    t = PASTED.sub(lambda m: "[붙여넣음] " + m.group(1).strip()[:300], t)
    t = re.sub(r"<system-reminder>.*?</system-reminder>", "", t, flags=re.S)
    return re.sub(r"[ \t]+", " ", t).strip()


def pieces(text, n_max, from_end=False):
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    out, cur = [], ""
    for p in paras:
        while len(p) > MAX:
            if cur:
                out.append(cur); cur = ""
            out.append(p[:MAX]); p = p[MAX:]
        if len(cur) + len(p) + 1 > MAX and cur:
            out.append(cur); cur = p
        else:
            cur = (cur + "\n" + p).strip()
    if cur:
        out.append(cur)
    return out[-n_max:] if from_end else out[:n_max]


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(i.get("text", "") for i in content if isinstance(i, dict) and i.get("type") == "text")
    return ""


def claude_turns(path):
    turns, cur, cwd = [], None, None
    for line in open(path, "rb"):
        try:
            v = json.loads(line)
        except Exception:
            continue
        if v.get("isSidechain"):
            continue
        cwd = v.get("cwd") or cwd
        ts = v.get("timestamp", "")
        t = v.get("type")
        human = None
        if t == "user" and not v.get("isMeta") and not v.get("isCompactSummary"):
            c = (v.get("message") or {}).get("content")
            s = text_of(c)
            if s and not s.lstrip().startswith(CLAUDE_NOISE):
                human = s
            elif isinstance(c, list) and cur:
                for it in c:
                    if isinstance(it, dict) and it.get("type") == "tool_result" and it.get("is_error"):
                        e = it.get("content")
                        e = e if isinstance(e, str) else json.dumps(e, ensure_ascii=False)
                        cur["errors"].append(e[:300])
        elif t == "attachment":
            a = v.get("attachment") or {}
            if a.get("type") == "queued_command" and a.get("commandMode") == "prompt" and (a.get("origin") or {}).get("kind") in (None, "human"):
                s = text_of(a.get("prompt"))
                if s and not s.lstrip().startswith(CLAUDE_NOISE):
                    human = s
        elif t == "assistant" and cur:
            for it in (v.get("message") or {}).get("content") or []:
                if isinstance(it, dict) and it.get("type") == "text":
                    cur["assistant"].append(it.get("text", ""))
                elif isinstance(it, dict) and it.get("type") == "tool_use" and it.get("name") in ("Edit", "Write", "MultiEdit"):
                    p = (it.get("input") or {}).get("file_path")
                    if p and p not in cur["files"]:
                        cur["files"].append(p)
        if human is not None:
            cur = {"user": human, "assistant": [], "errors": [], "files": [], "ts": ts, "cwd": cwd}
            turns.append(cur)
    return turns


def codex_turns(path):
    turns, cur, cwd = [], None, None
    for line in open(path, "rb"):
        try:
            v = json.loads(line)
        except Exception:
            continue
        p = v.get("payload") or {}
        if v.get("type") == "session_meta":
            cwd = p.get("cwd") or cwd
        if v.get("type") != "event_msg" or p.get("type") != "item_completed":
            continue
        item = p.get("item") or {}
        texts = "\n".join(x.get("text", "") for x in item.get("content") or [] if isinstance(x, dict))
        if item.get("type") == "UserMessage" and texts and not texts.lstrip().startswith(CODEX_NOISE):
            cur = {"user": texts, "assistant": [], "errors": [], "files": [], "ts": v.get("timestamp", ""), "cwd": cwd}
            turns.append(cur)
        elif item.get("type") == "AgentMessage" and cur:
            cur["assistant"].append(texts)
        elif item.get("type") == "FileChange" and cur:
            for f in (item.get("changes") or {}):
                if f not in cur["files"]:
                    cur["files"].append(f)
    return turns


def main():
    os.makedirs(OUT, exist_ok=True)
    srcs = [("claude", f) for f in glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl"))]
    srcs += [("codex", f) for f in glob.glob(os.path.expanduser("~/.codex/sessions/**/*.jsonl"), recursive=True)]
    chunks, turns_out = [], []
    for agent, f in srcs:
        sess = f"{agent}:{os.path.basename(f)[:-6]}"
        for i, t in enumerate(claude_turns(f) if agent == "claude" else codex_turns(f)):
            key = f"{sess}#{i}"
            proj = os.path.basename(t["cwd"] or "") or "?"
            head = f"[{proj} {t['ts'][:10]}] "
            user = clean(t["user"])
            asst = clean("\n\n".join(t["assistant"]))
            turns_out.append({"key": key, "project": proj, "ts": t["ts"], "user": user, "assistant": asst, "files": t["files"]})
            for j, p in enumerate(pieces(user, 3)):
                chunks.append({"turn": key, "kind": "user", "text": head + p})
            for p in pieces(asst, 6, from_end=True):
                chunks.append({"turn": key, "kind": "assistant", "text": head + p})
            for e in dict.fromkeys(clean(e) for e in t["errors"][:3]):
                chunks.append({"turn": key, "kind": "error", "text": head + "오류: " + e})
            if t["files"]:
                chunks.append({"turn": key, "kind": "edit", "text": head + "수정: " + ", ".join(os.path.basename(x) for x in t["files"][:12])})
    for i, c in enumerate(chunks):
        c["id"] = i
    with open(os.path.join(OUT, "chunks.jsonl"), "w") as w:
        for c in chunks:
            w.write(json.dumps(c, ensure_ascii=False) + "\n")
    with open(os.path.join(OUT, "turns.jsonl"), "w") as w:
        for t in turns_out:
            w.write(json.dumps(t, ensure_ascii=False) + "\n")
    kinds = {}
    for c in chunks:
        kinds[c["kind"]] = kinds.get(c["kind"], 0) + 1
    print("sessions", len(srcs), "turns", len(turns_out), "chunks", len(chunks), kinds,
          "chars", sum(len(c["text"]) for c in chunks))


if __name__ == "__main__":
    main()
