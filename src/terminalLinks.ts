import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

export interface PathToken { path: string; text: string; start: number; end: number }
/** Keep offsets in UTF-16; terminal cells are mapped separately (Korean/emoji are not one column). */
export function terminalPaths(text: string): PathToken[] {
  const tokens: PathToken[] = [];
  const pattern = /`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s`"'<>\[\]{}(),;│┃]+)/g;
  for (const match of text.matchAll(pattern)) {
    const quoted = match[1] ?? match[2] ?? match[3];
    const value = (quoted ?? match[4]).replace(/[.:!?]+$/, "");
    if (!value || /^[a-z][a-z\d+.-]*:\/\//i.test(value)) continue;
    const path = value.replace(/(?::\d+){1,2}$|#L\d+(?:C\d+)?$/, "");
    if (!path || !/[\p{L}\p{N}_]/u.test(path)) continue;
    const start = match.index! + (quoted !== undefined ? 1 : 0);
    tokens.push({ path, text: value, start, end: start + value.length });
    if (tokens.length === 64) break;
  }
  return tokens;
}

interface Position { x: number; y: number }
export interface TerminalPathContext { worktree: string; cwd: string }
export function fileLinkProvider(
  term: Terminal,
  context: () => TerminalPathContext | null,
  resolve: (context: TerminalPathContext, paths: string[]) => Promise<(string | null)[]>,
  open: (context: TerminalPathContext, rel: string) => void,
): ILinkProvider {
  return { provideLinks(row, callback) {
    const ctx = context();
    if (!ctx) return callback(undefined);
    const buffer = term.buffer.active;
    let first = row - 1;
    while (first > 0 && row - first < 64 && buffer.getLine(first)?.isWrapped) first--;
    let last = row - 1;
    while (last + 1 < buffer.length && last - first < 64 && buffer.getLine(last + 1)?.isWrapped) last++;
    let text = "";
    const starts: Position[] = [], ends: Position[] = [];
    for (let y = first; y <= last; y++) {
      const line = buffer.getLine(y);
      if (!line) break;
      for (let x = 0; x < Math.min(term.cols, line.length); x++) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        // A wide glyph can wrap early, leaving an empty padding cell at the preceding line end.
        if (x === term.cols - 1 && !cell.getCode() && buffer.getLine(y + 1)?.isWrapped && buffer.getLine(y + 1)?.getCell(0)?.getWidth() === 2) continue;
        const chars = cell.getChars() || " ";
        text += chars;
        for (let i = 0; i < chars.length; i++) {
          starts.push({ x: x + 1, y: y + 1 });
          ends.push({ x: x + cell.getWidth(), y: y + 1 });
        }
      }
    }
    const tokens = terminalPaths(text).filter(t => starts[t.start]?.y <= row && ends[t.end - 1]?.y >= row);
    if (!tokens.length) return callback(undefined);
    void resolve(ctx, tokens.map(t => t.path)).then(resolved => {
      const links: ILink[] = [];
      tokens.forEach((token, i) => {
        if (!resolved[i]) return;
        links.push({ text: token.text, range: { start: starts[token.start], end: ends[token.end - 1] },
          activate: () => {
            // Recheck when clicked: files may have disappeared or symlinks may have changed since hover.
            void resolve(ctx, [token.path]).then(result => { if (result[0]) open(ctx, result[0]); }, () => {});
          },
        });
      });
      callback(links.length ? links : undefined);
    }, () => callback(undefined));
  } };
}
