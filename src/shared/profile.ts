import type { AgentProfile } from "./types";

// A project's own goal and soul live in special files inside the project
// folder itself, so they travel with the project and can be edited with
// any text editor: <project>/.parnassus/goal.md and soul.md. A missing or
// empty file means that field inherits the generic value. The folder is
// app metadata, never scanned or copied in as project content.
export const PROFILE_DIR = ".parnassus";
export const GOAL_FILE = "goal.md";
export const SOUL_FILE = "soul.md";

// The generic goal and soul: what the agent is for, and how it should be,
// when a project does not state its own. Every project starts out using
// these and can override either field; updating the generic values flows
// to every project that has not overridden them.
export const GENERIC_PROFILE: AgentProfile = {
  goal: "Help with whatever the user is working on.",
  soul: "You are Muse, a helpful and careful agent. Be direct, do the work, and ask before anything hard to undo.",
};

export interface ResolvedProfile extends AgentProfile {
  goalInherited: boolean;
  soulInherited: boolean;
}

export function resolveProfile(
  project: { goal?: string | null; soul?: string | null } | null,
  generic: AgentProfile,
): ResolvedProfile {
  const goal = project?.goal ?? null;
  const soul = project?.soul ?? null;
  return {
    goal: goal ?? generic.goal,
    soul: soul ?? generic.soul,
    goalInherited: goal === null,
    soulInherited: soul === null,
  };
}
