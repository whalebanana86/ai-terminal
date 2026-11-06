// 저장소 탭 닫기. 그 저장소에서 앱 터미널이 띄운 AI 가 돌고 있으면 멈출지 먼저 묻는다.
// 앱 밖(다른 터미널)에서 띄운 AI 는 남의 프로세스라 끝내지 않는다. 탭을 닫아도 영향이 없어서 그것만 있으면 묻지 않는다.
import { api, errorText } from "./api";
import { t } from "./i18n";
import { type RepoRuns, runsInRepo, stateCounts } from "./repoAgents";
import { useStore } from "./store";

/** 확인창 글. 앱 터미널 실행이 없으면 묻지 않는다(null). 빨간 단추(alt)가 멈추기, 기본 단추는 그대로 두기 */
export function closePrompt(name: string, r: RepoRuns) {
  if (!r.execIds.length) return null;
  const lines = [
    t("앱 터미널에서 띄운 AI {n}개가 아직 돌고 있어요 ({states}).", { n: r.execIds.length, states: stateCounts(r.app) }),
    t("멈추면 프로세스를 끝내요. 대화 기록은 남아 있어 나중에 이어갈 수 있어요."),
    t("그대로 두면 탭만 닫히고 AI 는 계속 돌아요."),
  ];
  if (r.outside) lines.push(t("다른 터미널에서 띄운 AI {n}개는 멈추지 않아요.", { n: r.outside }));
  return {
    title: t("{name} 에서 AI 가 실행 중이에요", { name }),
    body: lines.join("\n"),
    confirmLabel: t("그대로 두고 닫기"),
    altLabel: t("멈추고 닫기"),
  };
}

/** 저장소 탭을 닫는다. 닫았으면 true, 취소했거나 멈추지 못해 그대로 뒀으면 false */
export async function closeRepoTabAsking(id: string): Promise<boolean> {
  const s = useStore.getState();
  const repo = s.repos.find((r) => r.id === id);
  const runs = repo ? runsInRepo(id, s.repos, s.sessions, s.liveRuns, s.execs) : null;
  const ask = repo && runs ? closePrompt(repo.name, runs) : null;
  if (ask && runs) {
    const pick = await s.choose(ask);
    if (!pick) return false;
    if (pick === "alt") {
      // 묻는 사이 스스로 끝난 실행은 건너뛴다(목록에서 지워졌으면 "찾을 수 없음"이 난다)
      const alive = runs.execIds.filter((x) => useStore.getState().execs.some((e) => e.id === x && !e.exited));
      const failed = (await Promise.all(alive.map((x) => api.execKill(x).then(() => null, (e: unknown) => errorText(e))))).filter((x) => x !== null);
      if (failed.length) {
        useStore.getState().toast("error", t("AI 를 멈추지 못해 탭을 닫지 않았어요: {error}", { error: failed.join(", ") }));
        return false;
      }
    }
  }
  useStore.getState().closeRepoTab(id);
  return true;
}
