import { api } from "./api";
import { t } from "./i18n";
import { useStore } from "./store";

/**
 * 저장소 설정(.git)에 Git 이 실행하는 명령(변환 필터·훅 등)이 있으면, 믿기 전에는 앱이 그 명령을 끈 채로 Git 을 쓴다.
 * 남에게 받은 저장소(.git 까지 든 압축 등)는 열기만 해도 명령이 실행될 수 있어서다. 믿을지 묻고, 믿으면 true.
 */
export async function askTrust(worktree: string, items: string[]): Promise<boolean> {
  const ok = await useStore.getState().ask({
    title: t("이 저장소를 믿을까요?"),
    body:
      t("이 저장소의 Git 설정(.git)에 실행되는 명령이 있어요. 남에게 받은 저장소라면 열기만 해도 실행될 수 있어 지금은 꺼 두었어요.") +
      "\n\n" +
      items.map((i) => `• ${i}`).join("\n") +
      "\n\n" +
      t("직접 만들었거나 믿을 수 있는 저장소면 '믿기'를 누르세요. 믿지 않으면 명령을 끈 채로 보여 줘요(Git LFS 처럼 변환을 쓰는 파일은 바뀐 것처럼 보일 수 있어요)."),
    confirmLabel: t("믿기"),
    danger: true,
  });
  if (!ok) return false;
  await api.repoTrust(worktree);
  return true;
}

/** 이 저장소를 이번에 이미 물어봤는지(같은 실행 동안 다시 띄우지 않는다. 안내 막대는 남는다) */
const asked = new Set<string>();
export function firstAsk(key: string): boolean {
  if (asked.has(key)) return false;
  asked.add(key);
  return true;
}
