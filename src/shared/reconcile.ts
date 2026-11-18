import type { FileState, ManifestEntry, SyncState } from "./types";

export interface SideSnapshot {
  hash: string;
}

// The three-way state computation, pure so both bridges and the unit tests
// share one definition. base is the manifest from copy-in; local and muse
// are the current hashes on each side. A missing entry means the file does
// not exist on that side (or was never copied in).
export function computeFileStates(
  base: Map<string, ManifestEntry>,
  local: Map<string, SideSnapshot>,
  muse: Map<string, SideSnapshot>,
): FileState[] {
  const paths = new Set<string>([...base.keys(), ...local.keys(), ...muse.keys()]);
  const states: FileState[] = [];
  for (const path of [...paths].sort()) {
    const baseEntry = base.get(path);
    const localEntry = local.get(path);
    const museEntry = muse.get(path);
    states.push({ path, state: stateFor(baseEntry, localEntry, museEntry) });
  }
  return states;
}

function stateFor(
  base: ManifestEntry | undefined,
  local: SideSnapshot | undefined,
  muse: SideSnapshot | undefined,
): SyncState {
  const baseHash = base?.hash;
  const localChanged = local?.hash !== baseHash;
  const museChanged = muse?.hash !== baseHash;
  // A path with no base entry exists on one side only: it is a change on
  // that side, unless both sides hold the same content already.
  if (baseHash === undefined) {
    if (local && muse) return local.hash === muse.hash ? "in-sync" : "conflict";
    if (local) return "local-changed";
    if (muse) return "muse-changed";
    return "in-sync";
  }
  if (localChanged && museChanged) {
    // Both sides moved. If they landed on the same thing, including both
    // deleting the file, there is nothing to resolve.
    if (local?.hash === muse?.hash) return "in-sync";
    return "conflict";
  }
  if (localChanged) return "local-changed";
  if (museChanged) return "muse-changed";
  return "in-sync";
}

// Project-level summary of the per-file states. A conflict anywhere wins.
// Muse-side changes outrank local ones because they are the ones waiting on
// the user's approval; the per-file list carries the full detail either way.
export function aggregateState(files: FileState[]): SyncState {
  let state: SyncState = "in-sync";
  for (const file of files) {
    if (file.state === "conflict") return "conflict";
    if (file.state === "muse-changed") state = "muse-changed";
    else if (file.state === "local-changed" && state === "in-sync") {
      state = "local-changed";
    }
  }
  return state;
}
