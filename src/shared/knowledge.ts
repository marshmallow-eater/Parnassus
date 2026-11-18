// Project knowledge lives next to the goal and soul in the project's
// .parnassus folder: decisions.md records what was decided for this
// project and why; memory.md is the internal knowledge — instructions
// like "do this in that file", conventions, and facts about the files —
// that the user asks to have kept. Both are plain markdown in the user's
// folder, created at copy-in with starter headings and never overwritten
// once they exist.
export const DECISIONS_FILE = "decisions.md";
export const MEMORY_FILE = "memory.md";

export const DECISIONS_TEMPLATE = `# Decisions

Record each decision for this project here: what was decided, and why.

<!-- One entry per decision, newest first. Example:
## 2026-01-01 — Use the staging workflow for all writes
Because originals must never change without approval.
-->
`;

export const MEMORY_TEMPLATE = `# Project memory

Internal knowledge about this project: how things are done here, and
instructions the user gave for certain files.

<!-- Examples:
- In src/api.ts, always go through the retry helper; never call fetch directly.
- Report dates are written day-first.
-->
`;
