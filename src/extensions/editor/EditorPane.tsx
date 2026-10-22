// 확장 기능 "파일 편집": 파일 보기의 '편집' 탭. ⌘S 저장, ⌘F 찾기, Esc 로 내용 보기로.
// 저장할 때 불러온 뒤 밖(AI·다른 편집기)에서 바뀌었으면 덮어쓰지 않고 묻는다. 저장하지 않은 수정은 drafts 에 남는다.
import { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ExternalLink, GitMerge, Save, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, errorText, type EditableFile } from "../../api";
import { Empty } from "../../components/Overlays";
import { openExternal } from "../../externalEditor";
import { useFileTick } from "../../fileTick";
import { countAgentsIn } from "../../gitActions";
import { t } from "../../i18n";
import { useStore } from "../../store";
import { createEditor, languageFor } from "./cm";
import { dropDraft, getDraft, setDraft } from "./drafts";
import { isEditBranch, mergeIntoAgent, openInEditWorktree } from "./editWorktree";

type Outside = null | "changed" | "conflict";

export default function EditorPane({ worktree, rel, setMode }: { worktree: string; rel: string; setMode: (mode: "preview") => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  /** 마지막으로 디스크와 같았던 내용과 그때의 지문 */
  const saved = useRef<{ doc: Text | null; hash: string; crlf: boolean; bom: boolean }>({ doc: null, hash: "", crlf: false, bom: false });
  const [file, setFile] = useState<EditableFile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [outside, setOutside] = useState<Outside>(null);
  const [restored, setRestored] = useState(false);
  const [hideAgentNote, setHideAgentNote] = useState(false);
  const fileTick = useFileTick(rel, worktree);
  const agents = useStore((s) => countAgentsIn(s, worktree));
  const branch = useStore((s) => s.repos.flatMap((r) => r.worktrees).find((w) => w.path === worktree)?.branch ?? null);
  const actions = useRef({ save: (_force: boolean) => {}, leave: () => {} });

  const isDirty = () => !!view.current && !!saved.current.doc && !view.current.state.doc.eq(saved.current.doc);
  const remember = () => {
    const v = view.current;
    if (!v) return;
    if (isDirty()) setDraft(worktree, rel, { doc: v.state.doc, hash: saved.current.hash, crlf: saved.current.crlf, bom: saved.current.bom });
    else dropDraft(worktree, rel);
  };

  // 불러오기: 저장하지 않은 수정이 남아 있으면 그걸 이어서 보여 준다
  useEffect(() => {
    let alive = true;
    setErr(null);
    setFile(null);
    setOutside(null);
    setRestored(false);
    setSavedAt(null);
    (async () => {
      try {
        const f = await api.readForEdit(worktree, rel);
        if (!alive) return;
        setFile(f);
        if (f.text === null || !host.current) return;
        const draft = getDraft(worktree, rel);
        const { view: v, languageSlot } = createEditor(host.current, draft ? draft.doc.toString() : f.text, {
          onSave: () => actions.current.save(false),
          onLeave: () => actions.current.leave(),
          onChange: () => {
            setDirty(isDirty());
            remember();
          },
        });
        view.current = v;
        if (draft) {
          // 이어서 고치되 지문은 처음 불러올 때 것 그대로 → 그사이 밖에서 바뀌었으면 저장할 때 묻는다
          saved.current = { doc: textOf(f.text), hash: draft.hash, crlf: draft.crlf, bom: draft.bom };
          setRestored(true);
          if (draft.hash !== f.hash) setOutside("changed");
        } else {
          saved.current = { doc: v.state.doc, hash: f.hash, crlf: f.crlf, bom: f.bom };
        }
        setDirty(isDirty());
        v.focus();
        const lang = await languageFor(rel);
        if (alive && lang) v.dispatch({ effects: languageSlot.reconfigure(lang) });
      } catch (e) {
        if (alive) setErr(errorText(e));
      }
    })();
    return () => {
      alive = false;
      view.current?.destroy();
      view.current = null;
    };
  }, [worktree, rel]); // eslint-disable-line react-hooks/exhaustive-deps

  // 밖에서 이 파일이 바뀜(AI·다른 편집기·내 저장): 고치던 게 없으면 새 내용으로, 있으면 알리기만
  const firstTick = useRef(true);
  useEffect(() => {
    if (firstTick.current) {
      firstTick.current = false;
      return;
    }
    let alive = true;
    api.readForEdit(worktree, rel).then(
      (f) => {
        const v = view.current;
        if (!alive || !v || f.hash === saved.current.hash) return;
        if (!isDirty() && f.text !== null) {
          replaceWith(f);
        } else {
          setOutside("changed");
        }
      },
      () => alive && setOutside("changed"),
    );
    return () => {
      alive = false;
    };
  }, [fileTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (force: boolean) => {
    const v = view.current;
    if (!v || saving) return;
    const doc = v.state.doc;
    setSaving(true);
    try {
      const r = await api.saveFile({ worktree, rel, text: doc.toString(), crlf: saved.current.crlf, bom: saved.current.bom, expected: saved.current.hash, force });
      if (!r.saved) {
        setOutside("conflict");
        return;
      }
      saved.current = { ...saved.current, doc, hash: r.hash };
      setOutside(null);
      setRestored(false);
      setSavedAt(Date.now());
      setDirty(isDirty());
      remember();
    } catch (e) {
      useStore.getState().toast("error", t("저장하지 못했어요: {error}", { error: errorText(e) }));
    } finally {
      setSaving(false);
    }
  };

  /** 디스크 내용으로 바꿔 끼운다. 기준을 먼저 바꿔 두면 바꾸는 순간 '수정 없음'이 되어 임시 보관도 지워진다 */
  const replaceWith = (f: EditableFile) => {
    const v = view.current;
    if (!v || f.text === null) return;
    saved.current = { doc: textOf(f.text), hash: f.hash, crlf: f.crlf, bom: f.bom };
    const head = Math.min(v.state.selection.main.head, f.text.length);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: f.text }, selection: { anchor: head } });
    dropDraft(worktree, rel);
    setDirty(false);
    setOutside(null);
  };

  /** 밖에서 바뀐 내용을 다시 불러온다(내 수정은 버림) */
  const reload = async () => {
    const v = view.current;
    if (!v) return;
    try {
      const f = await api.readForEdit(worktree, rel);
      if (f.text === null) {
        setFile(f);
        return;
      }
      replaceWith(f);
      setRestored(false);
    } catch (e) {
      setErr(errorText(e));
    }
  };

  actions.current = {
    save: (force) => void save(force),
    leave: () => setMode("preview"),
  };

  const editWt = isEditBranch(branch);
  return (
    <div className="editor-pane" data-testid="editor-pane">
      {err && <div className="banner banner-error">{err}</div>}
      {file?.readonly ? (
        <Empty title={t("이 파일은 앱에서 고칠 수 없어요")}>
          <div>{file.readonly}</div>
          <button className="btn btn-small" style={{ marginTop: 8 }} onClick={() => void openExternal(worktree, rel)}>
            <ExternalLink size={13} aria-hidden /> {t("외부 편집기로 열기")}
          </button>
        </Empty>
      ) : (
        <>
          {editWt ? (
            <div className="banner banner-ext editor-note" data-testid="edit-worktree-note">
              <span>{t("내 수정 워크트리예요. AI 가 아직 커밋하지 않은 변경은 여기 없어요. 고친 뒤 커밋하고 합치세요.")}</span>
              <button className="btn btn-small" onClick={() => void mergeIntoAgent(worktree)} data-action="merge-into-agent">
                <GitMerge size={13} aria-hidden /> {t("AI 브랜치에 합치기")}
              </button>
            </div>
          ) : (
            agents > 0 &&
            !hideAgentNote && (
              <div className="banner banner-warn editor-note" data-testid="agent-note">
                <span>{t("이 워크트리에서 AI 가 {n}개 일하는 중이에요. 같은 파일을 고치면 서로 덮어쓸 수 있어요.", { n: agents })}</span>
                {branch && (
                  <button className="btn btn-small" onClick={() => void openInEditWorktree(worktree, rel)} data-action="open-edit-worktree">
                    {t("내 수정 워크트리에서 고치기")}
                  </button>
                )}
                <button className="icon-btn ghost" onClick={() => setHideAgentNote(true)} aria-label={t("닫기")} title={t("여기서 그냥 고치기")}>
                  <X size={13} aria-hidden />
                </button>
              </div>
            )
          )}
          {outside && (
            <div className="banner banner-warn editor-note" data-testid="outside-note">
              <span>
                {outside === "conflict"
                  ? t("저장하지 않았어요. 불러온 뒤 밖(AI·다른 편집기)에서 이 파일이 바뀌었어요.")
                  : t("밖(AI·다른 편집기)에서 이 파일이 바뀌었어요. 내 수정은 아직 그대로예요.")}
              </span>
              <button className="btn btn-small" onClick={() => void reload()} data-action="reload">
                {t("다시 불러오기 (내 수정 버림)")}
              </button>
              <button className="btn btn-small btn-danger" onClick={() => void save(true)} data-action="overwrite">
                {t("내 것으로 덮어쓰기")}
              </button>
            </div>
          )}
          {restored && !outside && (
            <div className="banner editor-note" data-testid="draft-note">
              <span>{t("저장하지 않은 수정을 이어서 보여 줘요.")}</span>
              <button className="btn btn-small" onClick={() => void reload()}>
                {t("수정 버리기")}
              </button>
            </div>
          )}
          <div className="editor-bar">
            <span className={`editor-state${dirty ? " dirty" : ""}`} data-testid="editor-state">
              {saving ? t("저장 중…") : dirty ? t("저장 안 됨") : savedAt ? t("저장했어요") : t("고칠 수 있어요")}
            </span>
            {file && (file.crlf || file.bom) && <span className="muted">{[file.crlf && "CRLF", file.bom && "BOM"].filter(Boolean).join(" · ")}</span>}
            <span className="spacer" />
            <span className="muted">{t("⌘F 찾기 · Esc 나가기")}</span>
            <button className="btn btn-small btn-primary" disabled={!dirty || saving} onClick={() => void save(false)} data-action="save-file" title={t("저장 (⌘S)")}>
              <Save size={13} aria-hidden /> {t("저장")}
            </button>
          </div>
        </>
      )}
      <div ref={host} className="editor-host" hidden={!!file?.readonly} />
    </div>
  );
}

/** 편집기와 같은 규칙(줄바꿈 \n)으로 만든 문서. doc.eq 로 '수정 없음'을 가린다 */
function textOf(text: string): Text {
  return Text.of(text.split("\n"));
}
