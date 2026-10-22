// CodeMirror 6 준비: 앱 색 변수로 칠한 테마(밝게/어둡게 자동), 파일 확장자별 언어(필요할 때만 불러옴), 단축키.
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, HighlightStyle, indentOnInput, StreamLanguage, syntaxHighlighting, type StreamParser } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { tags as tg } from "@lezer/highlight";

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--fg)", backgroundColor: "var(--bg-0)", font: "12px/1.5 var(--mono)" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.5" },
  ".cm-content": { caretColor: "var(--accent)", padding: "4px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": { backgroundColor: "var(--bg-0)", color: "var(--fg-faint)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "32px", padding: "0 8px 0 4px" },
  ".cm-activeLine": { backgroundColor: "var(--cm-active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--cm-active-line)", color: "var(--fg-dim)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--cm-selection)" },
  ".cm-selectionMatch": { backgroundColor: "var(--cm-match)" },
  ".cm-matchingBracket": { outline: "1px solid var(--line-2)", backgroundColor: "transparent" },
  ".cm-searchMatch": { backgroundColor: "var(--cm-match)", outline: "1px solid var(--warn)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--cm-selection)" },
  ".cm-panels": { backgroundColor: "var(--bg-1)", color: "var(--fg)", borderColor: "var(--line)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--line)" },
  ".cm-panel.cm-search": { fontFamily: "var(--sans)", fontSize: "12px", padding: "4px 8px" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontSize: "12px" },
  ".cm-textfield": { backgroundColor: "var(--bg-2)", border: "1px solid var(--line-2)", color: "var(--fg)", borderRadius: "4px" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--bg-3)", border: "1px solid var(--line-2)", color: "var(--fg)", borderRadius: "4px" },
});

// 코드 색은 styles.css 의 --syn-* (밝게/어둡게 따로)
const highlight = HighlightStyle.define([
  { tag: [tg.keyword, tg.controlKeyword, tg.operatorKeyword, tg.modifier, tg.definitionKeyword, tg.moduleKeyword], color: "var(--syn-keyword)" },
  { tag: [tg.string, tg.special(tg.string), tg.character, tg.docString], color: "var(--syn-string)" },
  { tag: [tg.regexp, tg.escape], color: "var(--syn-string2)" },
  { tag: [tg.comment, tg.lineComment, tg.blockComment, tg.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [tg.number, tg.bool, tg.null, tg.atom, tg.constant(tg.variableName), tg.standard(tg.variableName)], color: "var(--syn-constant)" },
  { tag: [tg.function(tg.variableName), tg.function(tg.propertyName), tg.macroName], color: "var(--syn-function)" },
  { tag: [tg.typeName, tg.className, tg.namespace, tg.definition(tg.typeName)], color: "var(--syn-type)" },
  { tag: [tg.propertyName, tg.attributeName], color: "var(--syn-property)" },
  { tag: [tg.tagName, tg.angleBracket], color: "var(--syn-tag)" },
  { tag: [tg.definition(tg.variableName), tg.labelName], color: "var(--syn-variable)" },
  { tag: [tg.heading], color: "var(--syn-keyword)", fontWeight: "bold" },
  { tag: tg.strong, fontWeight: "bold" },
  { tag: tg.emphasis, fontStyle: "italic" },
  { tag: [tg.link, tg.url], color: "var(--syn-string)", textDecoration: "underline" },
  { tag: [tg.meta, tg.processingInstruction], color: "var(--syn-comment)" },
  { tag: tg.inserted, color: "var(--add)" },
  { tag: tg.deleted, color: "var(--del)" },
  { tag: tg.invalid, color: "var(--err)" },
]);

const legacy = (p: Promise<StreamParser<unknown>>) => p.then((parser) => StreamLanguage.define(parser));

/** 파일 이름으로 언어를 고른다. 모르는 형식이면 null(글자만). */
export async function languageFor(rel: string): Promise<Extension | null> {
  const name = rel.split("/").pop()!.toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  if (name === "dockerfile" || name.endsWith(".dockerfile")) return legacy(import("@codemirror/legacy-modes/mode/dockerfile").then((m) => m.dockerFile));
  if (["makefile", "gnumakefile"].includes(name)) return legacy(import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell));
  if ([".zshrc", ".bashrc", ".bash_profile", ".zprofile", ".profile", ".env"].includes(name)) return legacy(import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell));
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "jsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "ts":
    case "mts":
    case "cts":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true });
    case "json":
    case "jsonc":
    case "json5":
      return (await import("@codemirror/lang-json")).json();
    case "css":
    case "scss":
    case "less":
      return (await import("@codemirror/lang-css")).css();
    case "html":
    case "htm":
    case "vue":
    case "svelte":
      return (await import("@codemirror/lang-html")).html();
    case "md":
    case "markdown":
    case "mdx":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "py":
    case "pyi":
      return (await import("@codemirror/lang-python")).python();
    case "rs":
      return (await import("@codemirror/lang-rust")).rust();
    case "yaml":
    case "yml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "go":
      return (await import("@codemirror/lang-go")).go();
    case "java":
      return (await import("@codemirror/lang-java")).java();
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
    case "hh":
    case "m":
    case "mm":
      return (await import("@codemirror/lang-cpp")).cpp();
    case "sql":
      return (await import("@codemirror/lang-sql")).sql();
    case "xml":
    case "svg":
    case "plist":
    case "xib":
    case "storyboard":
      return (await import("@codemirror/lang-xml")).xml();
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
      return legacy(import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell));
    case "toml":
      return legacy(import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml));
    case "swift":
      return legacy(import("@codemirror/legacy-modes/mode/swift").then((m) => m.swift));
    case "rb":
      return legacy(import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby));
    case "kt":
    case "kts":
      return legacy(import("@codemirror/legacy-modes/mode/clike").then((m) => m.kotlin));
    case "lua":
      return legacy(import("@codemirror/legacy-modes/mode/lua").then((m) => m.lua));
    default:
      return null;
  }
}

export interface EditorHooks {
  onSave: () => void;
  onChange: () => void;
}

/** 새 편집 화면. language 는 나중에 languageSlot 으로 끼운다(불러오는 동안에도 바로 칠 수 있게). */
export function createEditor(parent: HTMLElement, doc: string, hooks: EditorHooks): { view: EditorView; languageSlot: Compartment } {
  const languageSlot = new Compartment();
  const state = EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      rectangularSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: false }),
      syntaxHighlighting(highlight),
      languageSlot.of([]),
      theme,
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (hooks.onSave(), true) },
        ...searchKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => u.docChanged && hooks.onChange()),
    ],
  });
  return { view: new EditorView({ state, parent }), languageSlot };
}
