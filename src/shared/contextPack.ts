import { fnvHash } from "./classify";
import { FILE_REQUEST_INSTRUCTION } from "./fileRequest";
import type { ContextFile } from "./types";

// The context pack is how a project's chat learns what files it has:
// not the files themselves, but each file's name with a short description
// of what is inside (an opening excerpt for text, the kind and size for
// binaries), under the project's stated goal and soul. It is prepended
// to the first question a chat is asked, and sent again when it changes.

export interface ContextPackInput {
  projectName: string;
  goal: string;
  soul: string;
  memory?: string | null;
  files: ContextFile[];
  // Where this project's files live. rootPath is the user's own folder,
  // stagedPath the folder holding the working copies for this chat, and
  // workFolder the folder the agent must use on its side for this
  // project (see museWorkFolder in chatSession.ts).
  rootPath?: string;
  stagedPath?: string;
  workFolder?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const CLASS_DESCRIPTIONS: Record<ContextFile["fileClass"], string> = {
  text: "text",
  "readable-binary": "readable binary (image, PDF, audio, or office document)",
  "opaque-binary": "opaque binary (cannot be read as text)",
};

export function buildContextPack(input: ContextPackInput): string {
  const lines: string[] = [];
  lines.push(`Project: ${input.projectName}`);
  lines.push(
    `This chat is only for the project "${input.projectName}". Do not use it for any other project, and do not bring in files or context from other projects or from the General chat.`,
  );
  lines.push(
    `Name this chat "${input.projectName}" — if you can rename this conversation, set its name to exactly that, so it is listed under the project name.`,
  );
  if (input.rootPath) lines.push(`Project folder on my computer: ${input.rootPath}`);
  if (input.rootPath) {
    lines.push(`Project knowledge folder: ${input.rootPath}/.parnassus (goal.md, soul.md, decisions.md, memory.md)`);
  }
  if (input.stagedPath) {
    lines.push(`Working copies of this project's files are stored in: ${input.stagedPath}`);
  }
  if (input.workFolder) {
    lines.push(
      `Folder to use on your side for this project: ~/${input.workFolder}/ — create it if it does not exist, keep every file you make or change for this project in that folder only, and treat the file names below as relative to it.`,
    );
  }
  if (input.goal.trim() !== "") lines.push(`Goal: ${input.goal.trim()}`);
  if (input.soul.trim() !== "") lines.push(`Agent soul: ${input.soul.trim()}`);
  if (input.memory && input.memory.trim() !== "") {
    lines.push(`Project memory: ${input.memory.trim().slice(0, 800)}`);
  }
  lines.push("");
  if (input.files.length === 0) {
    lines.push("No files have been copied in for this project yet.");
  } else {
    // Tier one of the context: the project description above plus a
    // summary of each file — not the files themselves. Full content is
    // tier two, sent only for the files actually needed.
    lines.push("Files copied in for this project (summaries only):");
    for (const file of input.files) {
      const kind = CLASS_DESCRIPTIONS[file.fileClass];
      const inside = file.excerpt ? ` — starts: "${file.excerpt}"` : "";
      lines.push(`- ${file.path} (${kind}, ${formatSize(file.size)})${inside}`);
    }
    lines.push("");
    lines.push(
      `You have the project description and file summaries, not the full files. ${FILE_REQUEST_INSTRUCTION} Summaries are enough for everything else.`,
    );
  }
  return lines.join("\n");
}

// A stable fingerprint of a pack: when it changes, the chat's copy of the
// context is stale and the pack needs sending again.
export function contextSignature(pack: string): string {
  return fnvHash(new TextEncoder().encode(pack));
}

const RELEVANCE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with",
  "is", "are", "it", "this", "that", "what", "when", "where", "which",
  "how", "why", "should", "would", "could", "does", "did", "about",
]);

// Files a question is explicitly about: it names the file, or its words
// match the file's description. Those files go into the prompt in full,
// not just as a one-line description. Capped so one question cannot drag
// a whole project behind it.
export function pickRelevantFiles(question: string, files: ContextFile[]): string[] {
  const lower = question.toLowerCase();
  const questionTokens = new Set(
    lower.split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !RELEVANCE_STOPWORDS.has(t)),
  );
  const scored: { path: string; score: number }[] = [];
  for (const file of files) {
    if (file.fileClass !== "text") continue;
    let score = 0;
    if (lower.includes(file.path.toLowerCase())) score += 10;
    const descriptionTokens = new Set(
      `${file.path} ${file.excerpt ?? ""}`
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !RELEVANCE_STOPWORDS.has(t)),
    );
    for (const token of descriptionTokens) {
      if (questionTokens.has(token)) score += 1;
    }
    if (score >= 2) scored.push({ path: file.path, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.path);
}

// The full-contents block for picked files, appended after the pack.
// Text over the cap is truncated and says so; binaries never appear here.
export function buildRelevantFilesBlock(
  picked: { path: string; content: string | null }[],
): string {
  const parts: string[] = [];
  for (const file of picked) {
    if (file.content === null) continue;
    const cap = 12000;
    const body =
      file.content.length <= cap
        ? file.content
        : `${file.content.slice(0, cap)}\n[... truncated at ${cap} characters]`;
    parts.push(`Full content of ${file.path} (asked about explicitly):\n\`\`\`\n${body}\n\`\`\``);
  }
  return parts.join("\n\n");
}

// A one-or-two-line description of a text file's opening, for the pack.
export function excerptOf(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length <= 160 ? flat : `${flat.slice(0, 157)}...`;
}
