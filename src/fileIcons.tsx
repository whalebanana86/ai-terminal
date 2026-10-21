import {
  BookOpen,
  Container,
  Database,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileDiff,
  FileImage,
  FileJson,
  FileKey,
  FileLock,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Package,
  Scale,
  type LucideIcon,
} from "lucide-react";

/** 파일 종류별 아이콘. 아이콘 묶음을 따로 넣지 않고(앱 크기) 이미 쓰는 lucide 모양 + 언어 색으로 구분한다. */
export interface IconSpec {
  icon: LucideIcon;
  color: string;
  /** 접근성·테스트용 종류 이름 */
  kind: string;
}

const C = {
  ts: "#4f9ee8",
  js: "#e8cf4a",
  rust: "#f0835a",
  py: "#6aa7e8",
  go: "#4fd0e1",
  swift: "#f5743b",
  html: "#e8774a",
  css: "#a77ce8",
  json: "#e2c08d",
  config: "#9aa3b5",
  text: "#8fb4d8",
  shell: "#8bd17c",
  image: "#c792ea",
  media: "#ff7ab2",
  archive: "#d0a85c",
  data: "#56d4bc",
  key: "#e2c08d",
  git: "#f05133",
  plain: "#808a9c",
} as const;

const code = (color: string, kind: string): IconSpec => ({ icon: FileCode, color, kind });

const BY_EXT: Record<string, IconSpec> = {};
const add = (exts: string, spec: IconSpec) => exts.split(" ").forEach((e) => (BY_EXT[e] = spec));
add("ts tsx mts cts", code(C.ts, "typescript"));
add("js jsx mjs cjs", code(C.js, "javascript"));
add("rs", code(C.rust, "rust"));
add("py pyi ipynb", code(C.py, "python"));
add("go", code(C.go, "go"));
add("swift", code(C.swift, "swift"));
add("kt kts", code("#b07fff", "kotlin"));
add("java class jar", code("#e8913a", "java"));
add("c h cc cpp cxx hpp hh m mm", code("#6c9ee8", "c"));
add("cs", code("#9b72e8", "csharp"));
add("rb erb", code("#e0505a", "ruby"));
add("php", code("#8f9be0", "php"));
add("dart", code("#45b8e6", "dart"));
add("vue", code("#42b883", "vue"));
add("svelte", code("#ff6b3d", "svelte"));
add("lua", code("#6c7ce8", "lua"));
add("zig", code("#f7a41d", "zig"));
add("ex exs", code("#a074c4", "elixir"));
add("scala sc", code("#de4a3a", "scala"));
add("sql graphql gql prisma", code(C.data, "query"));
add("html htm xhtml", code(C.html, "html"));
add("css scss sass less styl", code(C.css, "css"));
add("json jsonc json5 jsonl ndjson", { icon: FileJson, color: C.json, kind: "json" });
add("toml yaml yml ini conf cfg properties plist xml editorconfig", { icon: FileCog, color: C.config, kind: "config" });
add("md mdx markdown txt rst adoc org log", { icon: FileText, color: C.text, kind: "text" });
add("pdf", { icon: FileText, color: "#ff6b6b", kind: "pdf" });
add("sh bash zsh fish ps1 bat cmd", { icon: FileTerminal, color: C.shell, kind: "shell" });
add("png jpg jpeg gif webp svg ico icns bmp tif tiff heic avif", { icon: FileImage, color: C.image, kind: "image" });
add("mp4 mov webm mkv avi m4v", { icon: FileVideo, color: C.media, kind: "video" });
add("mp3 wav flac ogg m4a aac", { icon: FileAudio, color: C.media, kind: "audio" });
add("zip tar gz tgz bz2 xz 7z rar dmg pkg zst", { icon: FileArchive, color: C.archive, kind: "archive" });
add("csv tsv xls xlsx numbers", { icon: FileSpreadsheet, color: C.data, kind: "sheet" });
add("sqlite sqlite3 db", { icon: Database, color: C.data, kind: "database" });
add("ttf otf woff woff2", { icon: FileType, color: C.config, kind: "font" });
add("lock", { icon: FileLock, color: C.plain, kind: "lock" });
add("pem key crt cer p12 pfx", { icon: FileKey, color: C.key, kind: "key" });
add("diff patch", { icon: FileDiff, color: C.shell, kind: "diff" });

const BY_NAME: Record<string, IconSpec> = {
  "package.json": { icon: Package, color: "#e8574a", kind: "npm" },
  "cargo.toml": { icon: Package, color: C.rust, kind: "cargo" },
  "package.swift": { icon: Package, color: C.swift, kind: "swiftpm" },
  "go.mod": { icon: Package, color: C.go, kind: "gomod" },
  "pyproject.toml": { icon: Package, color: C.py, kind: "python-project" },
  "package-lock.json": { icon: FileLock, color: C.plain, kind: "lock" },
  "pnpm-lock.yaml": { icon: FileLock, color: C.plain, kind: "lock" },
  "yarn.lock": { icon: FileLock, color: C.plain, kind: "lock" },
  dockerfile: { icon: Container, color: "#3fa7f0", kind: "docker" },
  makefile: { icon: FileTerminal, color: C.shell, kind: "make" },
  ".gitignore": { icon: GitBranch, color: C.git, kind: "git" },
  ".gitattributes": { icon: GitBranch, color: C.git, kind: "git" },
  ".gitmodules": { icon: GitBranch, color: C.git, kind: "git" },
  "claude.md": { icon: FileText, color: "#d97757", kind: "agent-rules" },
  "agents.md": { icon: FileText, color: "#10a37f", kind: "agent-rules" },
};

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  avif: "image/avif",
  heic: "image/heic",
};

/** 그림으로 보여 줄 수 있는 파일이면 MIME 형식, 아니면 null (Rust files::IMAGE_EXTS 와 같은 목록) */
export function imageMime(path: string): string | null {
  const dot = path.lastIndexOf(".");
  return dot > 0 ? (IMAGE_MIME[path.slice(dot + 1).toLowerCase()] ?? null) : null;
}

/** 파일 이름으로 아이콘을 고른다(이름 전체 → 접두어 → 확장자 순). */
export function fileIconSpec(name: string): IconSpec {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  if (/^readme(\.|$)/.test(lower)) return { icon: BookOpen, color: "#6cb6ff", kind: "readme" };
  if (/^(license|licence|copying)(\.|$)/.test(lower)) return { icon: Scale, color: C.json, kind: "license" };
  if (/^\.env(\.|$)/.test(lower)) return { icon: FileKey, color: C.key, kind: "env" };
  if (/^(docker-compose|compose)\.ya?ml$/.test(lower) || lower.startsWith("dockerfile.")) return { icon: Container, color: "#3fa7f0", kind: "docker" };
  if (/^(tsconfig|jsconfig)(\..*)?\.json$/.test(lower)) return { icon: FileCog, color: C.ts, kind: "tsconfig" };
  if (/^(vite|vitest|webpack|rollup|next|tailwind|postcss|eslint\.config|babel\.config)\b.*\.(js|cjs|mjs|ts)$/.test(lower)) return { icon: FileCog, color: C.css, kind: "build-config" };
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : lower.startsWith(".") ? lower.slice(1) : "";
  return BY_EXT[ext] ?? { icon: File, color: C.plain, kind: "file" };
}

/** 폴더 아이콘: 열림/닫힘, 자주 쓰는 폴더는 색으로 구분 */
export function folderIconSpec(name: string, open: boolean): IconSpec {
  const lower = name.toLowerCase();
  if (lower === ".git") return { icon: FolderGit2, color: C.git, kind: "git-folder" };
  const color =
    lower === "src" || lower === "sources" || lower === "lib" || lower === "app"
      ? "#6cb6ff"
      : lower === "test" || lower === "tests" || lower === "__tests__" || lower === "spec"
        ? "#8bd17c"
        : lower === "docs" || lower === "doc"
          ? "#56d4bc"
          : lower === "scripts" || lower === "bin" || lower === "tools"
            ? "#e8cf4a"
            : lower === "assets" || lower === "public" || lower === "static" || lower === "images" || lower === "icons"
              ? C.image
              : lower === "node_modules" || lower === "target" || lower === "dist" || lower === "build" || lower === ".next"
                ? C.plain
                : "#c9a86a";
  return { icon: open ? FolderOpen : Folder, color, kind: "folder" };
}

export function FileIcon({ name, dir, open }: { name: string; dir?: boolean; open?: boolean }) {
  const s = dir ? folderIconSpec(name, !!open) : fileIconSpec(name);
  const Icon = s.icon;
  return <Icon size={14} strokeWidth={1.8} color={s.color} className="file-icon" data-icon={s.kind} aria-hidden />;
}
