import { describe, expect, it } from "vitest";
import { classifyRequest, takeNewRequests } from "./requestKind";

describe("classifyRequest", () => {
  const cases: [string, string | null][] = [
    ["로그인 화면을 만들어 줘", "add"],
    ["설정에 다크 모드 토글 추가해줘", "add"],
    ["에러 메시지를 칸 아래에 추가해 줘", "add"],
    ["버튼 색을 파란색으로 바꿔 줘", "modify"],
    ["README 정리해 줘", "modify"],
    ["함수 이름 좀 수정해", "modify"],
    ["안 쓰는 파일 지워 줘", "delete"],
    ["로그 출력 코드 제거해", "delete"],
    ["에러 로그 지워 줘", "delete"],
    ["저장 버튼 누르면 에러 나", "bug"],
    ["버그 고쳐줘", "bug"],
    ["로그인이 안 돼", "bug"],
    ["추가 버튼 눌렀더니 앱이 튕겨", "bug"],
    ["이 함수가 뭐 하는 거야?", "question"],
    ["테스트할 저장소 뭐가 있어?", "question"],
    ["고머워요는 오타야", "bug"],
    ["고마워를 고머워요로 해줘", "modify"],
    ["제목을 굵은 글씨로 만들어 줘", "modify"],
    ["새로 만들어 줘", "add"],
    ["잘못된 줄 지워 줘", "delete"],
    ["버튼 추가해 줄 수 있어?", "add"],
    ["이어서 진행해", "add"],
    ["고마워", "add"],
    ["Add a dark mode toggle", "add"],
    ["add error handling to the parser", "add"],
    ["Fix the crash when saving", "bug"],
    ["fix typo in README", "bug"],
    ["fix the spacing in README", "modify"],
    ["Remove the unused imports", "delete"],
    ["the build fails on CI", "bug"],
    ["refactor the store", "modify"],
    ["what does this do?", "question"],
    ["there is a typo in the title", "bug"],
    ["ok, go ahead", "add"],
    ["qwerty 123", "add"],
    ["", null],
    ["   ", null],
  ];
  for (const [text, kind] of cases) it(`${text} → ${kind}`, () => expect(classifyRequest(text)).toBe(kind));
});

describe("takeNewRequests", () => {
  it("켜기 전 요청은 무시, 새로 생긴 요청만 한 번", () => {
    const seen = new Map<string, number>();
    const start = 1000;
    const s = [
      { id: "a", title: "A", lastPrompt: "옛 요청 추가해", lastPromptAt: 500 },
      { id: "b", title: "B", lastPrompt: "버그 고쳐", lastPromptAt: 1500 },
    ];
    expect(takeNewRequests(seen, s, start).map((r) => [r.sessionId, r.kind])).toEqual([["b", "bug"]]);
    expect(takeNewRequests(seen, s, start)).toEqual([]);
    s[0] = { ...s[0], lastPrompt: "파일 지워", lastPromptAt: 2000 };
    expect(takeNewRequests(seen, s, start).map((r) => r.kind)).toEqual(["delete"]);
  });
});
