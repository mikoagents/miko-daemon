export interface DiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface ParsedDiffFile {
  path: string;
  isNew: boolean;
  isDeleted: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  status?: "ok" | "too_large" | "binary";
}

/**
 * Parse a unified diff into structured data
 */
// Git's default patch headers use paired a/path and b/path prefixes, while
// diff.noprefix emits plain paths that may legitimately start with a/ or b/.
function usesDiffPathPrefixes(oldPath: string, newPath: string): boolean {
  return oldPath.startsWith("a/") && newPath.startsWith("b/");
}

function extractPathFromMetadata(lines: string[], prefix: "--- " | "+++ "): string | null {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  if (!line) {
    return null;
  }

  const path = line.slice(prefix.length).replace(/\t.*$/, "").trimEnd();
  return path === "/dev/null" ? null : path;
}

function extractPathFromDiffHeader(lines: string[]): string {
  const firstLine = lines[0] ?? "";
  const prefixedPathMatch = firstLine.match(/^a\/(.+) b\/(.+)$/);
  if (prefixedPathMatch) {
    return prefixedPathMatch[2];
  }

  const metadataPath =
    extractPathFromMetadata(lines, "+++ ") ?? extractPathFromMetadata(lines, "--- ");
  if (metadataPath) {
    return metadataPath;
  }

  const pathMatch = firstLine.match(/^(\S+)\s+(\S+)$/);
  if (pathMatch) {
    const [, oldPath, newPath] = pathMatch;
    const path = newPath === "/dev/null" ? oldPath : newPath;
    return usesDiffPathPrefixes(oldPath, newPath) ? path.slice(2) : path;
  }
  return "unknown";
}

function isMetadataLine(line: string): boolean {
  return (
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file mode") ||
    line.startsWith("deleted file mode")
  );
}

function parseHunkHeader(line: string): DiffHunk | null {
  const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!hunkMatch) return null;
  return {
    oldStart: parseInt(hunkMatch[1], 10),
    oldCount: parseInt(hunkMatch[2] ?? "1", 10),
    newStart: parseInt(hunkMatch[3], 10),
    newCount: parseInt(hunkMatch[4] ?? "1", 10),
    lines: [{ type: "header", content: line.match(/^(@@ .+? @@)/)?.[1] ?? line }],
  };
}

interface ParsedSectionBody {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

function parseSectionBody(lines: string[]): ParsedSectionBody {
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let additions = 0;
  let deletions = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    if (isMetadataLine(line)) continue;

    const newHunk = parseHunkHeader(line);
    if (newHunk) {
      if (currentHunk) hunks.push(currentHunk);
      currentHunk = newHunk;
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", content: line.slice(1) });
      additions++;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "remove", content: line.slice(1) });
      deletions++;
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ type: "context", content: line.slice(1) });
    } else if (line.length > 0 && !line.startsWith("\\")) {
      currentHunk.lines.push({ type: "context", content: line });
    }
  }

  if (currentHunk) hunks.push(currentHunk);

  return { hunks, additions, deletions };
}

export function parseDiff(diffText: string): ParsedDiffFile[] {
  if (!diffText || diffText.trim().length === 0) {
    return [];
  }

  const files: ParsedDiffFile[] = [];
  const fileSections = diffText.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split("\n");

    const isNew = section.includes("new file mode") || section.includes("--- /dev/null");
    const isDeleted = section.includes("deleted file mode") || section.includes("+++ /dev/null");
    const path = extractPathFromDiffHeader(lines);

    const { hunks, additions, deletions } = parseSectionBody(lines);

    files.push({ path, isNew, isDeleted, additions, deletions, hunks });
  }

  return files;
}

/**
 * Reconstruct the "new" version of a file from diff hunks.
 * Returns a map of new line numbers to their content.
 */
