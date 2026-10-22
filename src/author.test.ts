import { describe, expect, it } from "vitest";
import { AUTHOR_SHADES, authorInitials, authorKey, authorLabel, authorShade, isSingleAuthor } from "./author";

describe("authorInitials", () => {
  it("한글 이름은 첫 글자", () => {
    expect(authorInitials("김정우", "jw@x.kr")).toBe("김");
    expect(authorInitials("  김 정우 ", "")).toBe("김");
  });
  it("영문 두 단어는 머리글자 두 개(대문자)", () => {
    expect(authorInitials("jae woo", "")).toBe("JW");
    expect(authorInitials("John Ronald Tolkien", "")).toBe("JT");
  });
  it("영문 한 단어는 한 글자, 기호는 건너뜀", () => {
    expect(authorInitials("whalebanana86", "")).toBe("W");
    expect(authorInitials("dependabot[bot]", "")).toBe("D");
    expect(authorInitials("(bot) ci", "")).toBe("BC");
  });
  it("빈 이름은 이메일 앞부분, 둘 다 없으면 ?", () => {
    expect(authorInitials("", "jw.kim@x.kr")).toBe("JK");
    expect(authorInitials("  ", "dev@x.kr")).toBe("D");
    expect(authorInitials("", "")).toBe("?");
    expect(authorInitials("--", "")).toBe("?");
  });
});

describe("isSingleAuthor", () => {
  const r = (author: string, email: string) => ({ author, email });
  it("커밋이 없거나 한 사람이면 true", () => {
    expect(isSingleAuthor([])).toBe(true);
    expect(isSingleAuthor([r("jw", "jw@x.kr"), r("jw", "jw@x.kr")])).toBe(true);
  });
  it("이메일 대소문자만 다르면 같은 사람", () => {
    expect(isSingleAuthor([r("jw", "JW@X.kr"), r("jw", "jw@x.KR ")])).toBe(true);
  });
  it("이메일이 같으면 이름이 달라도 같은 사람", () => {
    expect(isSingleAuthor([r("jw", "jw@x.kr"), r("Jae Woo", "jw@x.kr")])).toBe(true);
  });
  it("이메일이 다르면 다른 사람", () => {
    expect(isSingleAuthor([r("jw", "jw@x.kr"), r("jw", "jw@y.kr")])).toBe(false);
  });
  it("이메일이 없으면 이름으로(대소문자 무시)", () => {
    expect(isSingleAuthor([r("JW", ""), r("jw", "")])).toBe(true);
    expect(isSingleAuthor([r("jw", ""), r("", "")])).toBe(false);
  });
});

describe("authorShade", () => {
  it("같은 사람은 같은 단계(이메일 대소문자 무시)", () => {
    expect(authorShade("jw", "JW@x.kr")).toBe(authorShade("다른 이름", "jw@X.KR"));
  });
  it("0 ~ 단계 수-1 안에서 고루 나뉨", () => {
    const seen = new Set(Array.from({ length: 50 }, (_, i) => authorShade("", `u${i}@x.kr`)));
    expect([...seen].every((s) => Number.isInteger(s) && s >= 0 && s < AUTHOR_SHADES)).toBe(true);
    expect(seen.size).toBe(AUTHOR_SHADES);
  });
});

describe("authorLabel·authorKey", () => {
  it("이름 <이메일>, 한쪽이 비면 있는 것만", () => {
    expect(authorLabel("jw", "jw@x.kr")).toBe("jw <jw@x.kr>");
    expect(authorLabel("jw", "")).toBe("jw");
    expect(authorLabel("", "jw@x.kr")).toBe("<jw@x.kr>");
    expect(authorLabel("", "")).toBe("");
  });
  it("열쇠는 이메일 우선", () => {
    expect(authorKey("JW", "")).toBe("jw");
    expect(authorKey("JW", " A@B.c ")).toBe("a@b.c");
  });
});
