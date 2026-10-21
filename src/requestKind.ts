/** AI 에게 보낸 요청을 추가·수정·삭제·버그·질문으로 나눈다(위쪽 막대의 스틱맨). 앱 안에서 글자만 보고 정하며 어디에도 보내지 않는다. */
export type RequestKind = "add" | "modify" | "delete" | "bug" | "question";

const BUG = /버그|오류|에러|이슈|오타|틀렸|틀린|틀려|잘못\s?(됐|되|된|나와|나옴|들어|적|썼|쓰)|이상해|이상하게|이상한\s?(게|데)|예외|크래시|깨져|깨짐|깨지|먹통|튕겨|튕김|멈춰|멈춤|죽어|죽는|안\s?(돼|되|됨|된다|나와|나옴|떠|뜸|열려|보여|먹|움직|눌려)|작동\s?(안|하지)|동작\s?(안|하지)|실패|문제가\s?(있|생|나|발생)|\b(bug|bugs|error|errors|exception|crash|crashes|crashed|broken|fails?|failing|failed|issue|issues|panic|traceback|regression|typo|typos|wrong)\b|not working|doesn't work|does not work/i;
const DELETE = /삭제|지워|지우|지운|제거|없애|빼\s?(줘|주|버|자|라)|날려|\b(remove|delete|drop|get rid of|strip out|uninstall)\b/i;
const ADD = /추가|만들어|만들자|만들기|만들고|넣어|넣자|넣고|붙여|붙이|생성|구현|도입|새로\s?(만들|넣|추가)|\b(add|create|implement|introduce|scaffold|generate)\b/i;
const MODIFY = /(?<!새)(?:으로|로)\s?해|수정|바꿔|바꾸|변경|고쳐|고치|개선|다듬|정리|리팩|옮겨|업데이트|올려|낮춰|키워|줄여|맞춰|\b(refactor|change|update|rename|modify|edit|improve|fix|tweak|adjust|move|rewrite|clean ?up)\b/i;

/** 동작은 아니지만 묻는 말(질문 칸) */
const QUESTION = /[?？]\s*$|뭐|무엇|어디|언제|왜|어떻게|어떤|몇\s?(개|번|시|명)|누가|누구|알려\s?줘|설명해|궁금|^(what|why|how|where|when|which|who|is|are|can|could|does|do|should|will|would)\b/i;

/** 패턴이 마지막으로(또는 처음으로) 나온 자리. 없으면 -1 */
function where(re: RegExp, text: string, last: boolean): number {
  const g = new RegExp(re.source, "gi");
  let pos = -1;
  for (const m of text.matchAll(g)) {
    pos = m.index ?? -1;
    if (!last) break;
  }
  return pos;
}

/**
 * 한국어는 동사가 끝에 오므로 "마지막에 나온 동작"을, 영어는 "처음 나온 동작"을 본다.
 * 오류·버그 낱말이 있으면 버그로 보되, 동작이 추가·삭제("에러 메시지 추가해 줘", "에러 로그 지워 줘")면 그 동작을 따른다.
 * 동작이 없고 묻는 말이면 질문, 그것도 아니면("진행해", "고마워" 같은 대답) null.
 */
export function classifyRequest(raw: string): RequestKind | null {
  // "A를 B로 만들어 줘"는 새로 만드는 게 아니라 바꾸는 것("새로 만들어 줘"는 그대로 추가)
  const text = raw.slice(0, 2000).replace(/(?<!새)(으로|로)(\s?)만들/g, "$1$2바꾸");
  if (!text.trim()) return null;
  const korean = /[가-힣]/.test(text);
  const bug = where(BUG, text, korean);
  const acts = (
    [
      ["add", where(ADD, text, korean)],
      ["delete", where(DELETE, text, korean)],
      ["modify", where(MODIFY, text, korean)],
    ] as [RequestKind, number][]
  ).filter(([, i]) => i >= 0);
  // 한국어: 가장 뒤의 동작, 영어: 가장 앞의 동작
  acts.sort((a, b) => (korean ? b[1] - a[1] : a[1] - b[1]));
  const act = acts[0];
  if (bug >= 0) {
    if (!act || act[0] === "modify") return "bug";
    // 한국어에서 오류 낱말이 동작 뒤에 오면("추가했더니 에러 나") 버그 신고다
    if (korean && bug > act[1]) return "bug";
    return act[0];
  }
  if (act) return act[0];
  return QUESTION.test(text.trim()) ? "question" : null;
}

export interface SeenRequest {
  sessionId: string;
  title: string;
  text: string;
  at: number;
  kind: RequestKind | null;
}

/**
 * 세션 목록이 바뀔 때 새로 생긴 요청만 고른다. seen 은 세션별 마지막으로 본 요청 시각(바꿔 가며 쓴다).
 * 처음 본 세션은 앱을 켠 뒤(startedAt 이후)의 요청만 새 것으로 본다(켜자마자 옛 기록이 쏟아지지 않게).
 */
export function takeNewRequests(
  seen: Map<string, number>,
  sessions: { id: string; title: string; lastPrompt?: string | null; lastPromptAt?: number }[],
  startedAt: number,
): SeenRequest[] {
  const out: SeenRequest[] = [];
  for (const s of sessions) {
    const at = s.lastPromptAt ?? 0;
    if (!s.lastPrompt || !at) continue;
    const prev = seen.get(s.id) ?? startedAt;
    if (at > prev) out.push({ sessionId: s.id, title: s.title, text: s.lastPrompt, at, kind: classifyRequest(s.lastPrompt) });
    seen.set(s.id, Math.max(prev, at));
  }
  return out.sort((a, b) => a.at - b.at);
}
