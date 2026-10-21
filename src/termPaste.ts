/** 실행 id → 그 터미널에 붙여넣는 함수. 터미널(xterm)은 늦게 불러오므로 앱은 이 작은 목록만 본다. */
export const termPasters = new Map<string, (text: string) => void>();
