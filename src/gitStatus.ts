// 같은 워크트리의 git status 를 여러 화면(Git 패널·파일 트리·에이전트의 바꾼 파일)이 함께 쓴다.
// 화면마다 따로 부르면 바뀐 신호 하나에 `git status --untracked-files=all` 이 화면 수만큼 돈다.
// 위험한 작업 전의 변경 개수 세기(gitActions·editWorktree)는 여기를 거치지 않고 바로 읽는다.
import { api, type WorktreeStatus } from "./api";
import { useStore } from "./store";

/** 끝난 결과를 같은 세대에서 다시 쓰는 시간. 한 신호에 화면들이 부르는 것은 몇 ms 안에 몰린다.
 *  감시하지 않는 워크트리처럼 신호 없이 바뀌는 경우가 있어 오래 두지 않는다. */
export const REUSE_MS = 1000;

type Entry = { gen: string; p: Promise<WorktreeStatus>; done: number | null };
const shared = new Map<string, Entry>();

/** 신호 세대: 지금 워크트리의 status 신호(statusTick) + 그 워크트리의 파일·git 신호. 하나라도 오르면 새로 읽는다. */
function generation(path: string): string {
  const s = useStore.getState();
  return `${s.statusTick}:${s.fsSignals[path]?.n ?? 0}:${s.gitSignals[path] ?? 0}`;
}

/** git status. 같은 세대에 이미 부른 것이 돌고 있거나 막 끝났으면 그 결과를 같이 쓴다.
 *  세대가 바뀌면 앞선 것이 돌고 있어도 기다리지 않고 새로 부른다(그건 바뀌기 전 모습일 수 있다). 실패는 같이 쓰지 않는다.
 *  돌려받은 결과는 화면들이 같이 쓰니 고치지 않는다. */
export function worktreeStatus(path: string): Promise<WorktreeStatus> {
  const gen = generation(path);
  const hit = shared.get(path);
  if (hit && hit.gen === gen && (hit.done === null || Date.now() - hit.done < REUSE_MS)) return hit.p;
  const entry: Entry = { gen, p: api.status(path), done: null };
  shared.set(path, entry);
  entry.p.then(
    () => {
      entry.done = Date.now();
    },
    () => {
      if (shared.get(path) === entry) shared.delete(path);
    },
  );
  return entry.p;
}
