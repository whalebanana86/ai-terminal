/**
 * 설정 → 기능에서 켜고 끄는 확장 기능. 각 기능은 정해진 자리(위쪽 막대·상태줄·파일 보기 탭)에만 끼워지고,
 * 켜져 있을 때만 코드를 불러온다. 켜고 끈 상태는 Rust 가 저장한다(파일 편집은 켤 때 맥 확인창을 거친다).
 */
import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { create } from "zustand";
import { api } from "../api";
import { t } from "../i18n";
import { useHasDraft } from "./editor/drafts";

export type ExtensionId = "editor" | "stickman" | "usage";

/** 파일 보기에 더하는 탭(내용·변경·일부 담기 옆) */
export interface FileModeSlot {
  key: `ext:${string}`;
  label: () => string;
  title?: () => string;
  /** 이 파일에서 탭을 보여 줄지 */
  available: (f: { rel: string; isImage: boolean }) => boolean;
  /** 탭 옆에 • 를 찍을지(예: 저장하지 않은 수정) */
  useBadge?: (worktree: string, rel: string) => boolean;
  View: LazyExoticComponent<ComponentType<{ worktree: string; rel: string }>>;
}

export interface ExtensionDef {
  id: ExtensionId;
  title: () => string;
  description: () => string;
  /** Rust(extensions.rs)의 기본값과 같게 */
  defaultEnabled: boolean;
  topbar?: LazyExoticComponent<ComponentType>;
  statusbar?: LazyExoticComponent<ComponentType>;
  fileModes?: FileModeSlot[];
}

export const EDIT_MODE = "ext:editor" as const;

export const EXTENSIONS: ExtensionDef[] = [
  {
    id: "editor",
    title: () => t("파일 편집"),
    description: () => t("파일 보기에 '편집' 탭을 더해요. 켜면 앱이 워크트리 안 파일을 저장할 수 있어요."),
    defaultEnabled: false,
    fileModes: [
      {
        key: EDIT_MODE,
        label: () => t("편집"),
        title: () => t("이 파일을 앱에서 고치기 (⌘S 저장)"),
        available: (f) => !f.isImage,
        useBadge: useHasDraft,
        View: lazy(() => import("./editor/EditorPane")),
      },
    ],
  },
  {
    id: "stickman",
    title: () => t("스틱맨"),
    description: () => t("위쪽 막대 오른쪽에서 요청 종류마다 동작하고 오늘 요청 수를 세요."),
    defaultEnabled: true,
    topbar: lazy(() => import("../components/StickBuddy").then((m) => ({ default: m.StickBuddy }))),
  },
  {
    id: "usage",
    title: () => t("구독 한도 표시"),
    description: () => t("아래 상태줄에 Claude·Codex 의 5시간·주간 한도 사용률을 보여 줘요. 끄면 로그인 정보를 읽지 않아요."),
    defaultEnabled: true,
    statusbar: lazy(() => import("../components/SubscriptionUsage").then((m) => ({ default: m.SubscriptionUsage }))),
  },
];

interface ExtStore {
  enabled: Record<ExtensionId, boolean>;
  /** Rust 에서 읽어 왔는지(읽기 전에는 아무것도 그리지 않아 꺼 둔 기능이 잠깐 보이지 않게) */
  loaded: boolean;
  load: () => Promise<void>;
  /** 돌려받은 값이 실제 상태(파일 편집 확인창에서 취소하면 그대로) */
  set: (id: ExtensionId, on: boolean) => Promise<boolean>;
}

const defaults = Object.fromEntries(EXTENSIONS.map((e) => [e.id, e.defaultEnabled])) as Record<ExtensionId, boolean>;

function apply(list: { id: string; enabled: boolean }[]): Record<ExtensionId, boolean> {
  const out = { ...defaults };
  for (const x of list) if (x.id in out) out[x.id as ExtensionId] = x.enabled;
  return out;
}

export const useExtensions = create<ExtStore>((set, get) => ({
  enabled: defaults,
  loaded: false,
  load: async () => {
    let list: { id: string; enabled: boolean }[] | null = null;
    try {
      list = await api.extensionsList();
    } catch {
      /* 못 읽으면 기본값 */
    }
    set({ enabled: list ? apply(list) : defaults, loaded: true });
  },
  set: async (id, on) => {
    const list = await api.extensionSet(id, on);
    set({ enabled: apply(list) });
    return get().enabled[id];
  },
}));

export function useExtensionOn(id: ExtensionId): boolean {
  return useExtensions((s) => s.loaded && s.enabled[id]);
}

/** 위쪽 막대·상태줄의 확장 자리 */
export function ExtensionSlot({ name }: { name: "topbar" | "statusbar" }) {
  const enabled = useExtensions((s) => s.enabled);
  const loaded = useExtensions((s) => s.loaded);
  if (!loaded) return null;
  return (
    <>
      {EXTENSIONS.filter((e) => enabled[e.id] && e[name]).map((e) => {
        const C = e[name]!;
        return (
          <Suspense key={e.id} fallback={null}>
            <C />
          </Suspense>
        );
      })}
    </>
  );
}

/** 켜진 기능이 파일 보기에 더하는 탭 */
export function useFileModes(): FileModeSlot[] {
  const enabled = useExtensions((s) => s.enabled);
  const loaded = useExtensions((s) => s.loaded);
  return loaded ? EXTENSIONS.filter((e) => enabled[e.id]).flatMap((e) => e.fileModes ?? []) : [];
}
