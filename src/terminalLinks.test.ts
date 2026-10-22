import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { fileLinkProvider, terminalPaths } from "./terminalLinks";

describe("terminal file paths", () => {
  it("finds relative, absolute, bare, Korean and quoted space paths with locations", () => {
    const text = '확인 `src/App.tsx:12:3`, /tmp/repo/한글.ts#L2 "docs/my file.md" README.md Makefile';
    const tokens = terminalPaths(text);
    expect(tokens.map(t => t.path)).toEqual(['확인','src/App.tsx','/tmp/repo/한글.ts','docs/my file.md','README.md','Makefile']);
    for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(token.text);
  });
  it("excludes web links, punctuation, and bounds IPC work", () => {
    expect(terminalPaths('https://example.com/a.ts () <> --')).toEqual([]);
    expect(terminalPaths(Array(100).fill('file.ts').join(' '))).toHaveLength(64);
  });
  it("joins wrapped paths and maps wide Korean prefixes to terminal columns", async () => {
    const lines = [
      { wrap:false, cells:[['한',2],['',0],[' ',1],...Array.from('src/long',c=>[c,1])] },
      { wrap:true, cells:Array.from('/file.ts:2',c=>[c,1]) },
    ];
    const fake = { cols:11, buffer:{ active:{length:2,getLine:(i:number)=> {
      const line=lines[i]; if(!line)return undefined;
      return {isWrapped:line.wrap,length:line.cells.length,getCell:(x:number)=>{
        const c=line.cells[x]; return c ? {getChars:()=>c[0],getWidth:()=>c[1],getCode:()=>String(c[0]).codePointAt(0)??0}:undefined;
      }};
    }}}} as unknown as Terminal;
    let opened = '';
    const provider = fileLinkProvider(fake,()=>({worktree:'/repo',cwd:'/repo'}),async (_, paths)=>paths.map(p=>p==='src/long/file.ts'?'src/long/file.ts':null),(_,rel)=>{opened=rel;});
    const links = await new Promise<any>(r=>provider.provideLinks(2,r));
    expect(links).toHaveLength(1);
    expect(links[0].range).toEqual({start:{x:4,y:1},end:{x:10,y:2}});
    links[0].activate(); await new Promise(r=>setTimeout(r,0));
    expect(opened).toBe('src/long/file.ts');
  });
  it("does not open a stale link if its file disappears", async () => {
    const text='README.md';
    const term={cols:text.length,buffer:{active:{length:1,getLine:()=>({isWrapped:false,length:text.length,getCell:(x:number)=>({getChars:()=>text[x],getWidth:()=>1,getCode:()=>text.charCodeAt(x)})})}}} as unknown as Terminal;
    let exists=true,opened=false;
    const provider=fileLinkProvider(term,()=>({worktree:'/repo',cwd:'/repo'}),async()=>[exists?'README.md':null],()=>{opened=true;});
    const links=await new Promise<any>(r=>provider.provideLinks(1,r));
    exists=false;links[0].activate();await new Promise(r=>setTimeout(r,0));expect(opened).toBe(false);
  });
});
