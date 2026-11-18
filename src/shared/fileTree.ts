import { aggregateState } from "./reconcile";
import type { FileState, SyncState } from "./types";

// A project's copied-in files as a folder tree for the side pane: each
// leaf is a file with its sync state, each folder carries the aggregate
// state of everything under it, so "what is not synced" is visible at
// every level without opening anything.

export interface FileTreeNode {
  name: string;
  path: string;
  isFolder: boolean;
  state: SyncState;
  children: FileTreeNode[];
}

export function buildFileTree(files: FileState[]): FileTreeNode[] {
  const roots = new Map<string, FileTreeNode>();
  const byPath = new Map<string, FileTreeNode>();

  const ensureFolder = (segments: string[], depth: number): FileTreeNode => {
    const path = segments.slice(0, depth + 1).join("/");
    const existing = byPath.get(path);
    if (existing) return existing;
    const node: FileTreeNode = {
      name: segments[depth]!,
      path,
      isFolder: true,
      state: "in-sync",
      children: [],
    };
    byPath.set(path, node);
    if (depth === 0) roots.set(path, node);
    else ensureFolder(segments, depth - 1).children.push(node);
    return node;
  };

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const segments = file.path.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    const leaf: FileTreeNode = {
      name: segments[segments.length - 1]!,
      path: file.path,
      isFolder: false,
      state: file.state,
      children: [],
    };
    if (segments.length === 1) roots.set(file.path, leaf);
    else ensureFolder(segments, segments.length - 2).children.push(leaf);
    byPath.set(file.path, leaf);
  }

  const sortNodes = (nodes: FileTreeNode[]): FileTreeNode[] =>
    nodes
      .map((node) => ({ ...node, children: sortNodes(node.children) }))
      .sort((a, b) =>
        a.isFolder === b.isFolder
          ? a.name.localeCompare(b.name)
          : a.isFolder
            ? -1
            : 1,
      );

  const withFolderStates = (node: FileTreeNode): FileTreeNode => {
    if (!node.isFolder) return node;
    const children = node.children.map(withFolderStates);
    const state = aggregateState(
      children.flatMap((child) =>
        child.isFolder
          ? collectFiles(child)
          : [{ path: child.path, state: child.state }],
      ),
    );
    return { ...node, children, state };
  };

  return sortNodes([...roots.values()]).map(withFolderStates);
}

function collectFiles(node: FileTreeNode): FileState[] {
  if (!node.isFolder) return [{ path: node.path, state: node.state }];
  return node.children.flatMap(collectFiles);
}

// Counts per sync state, for the selected project's one-line summary.
export function countByState(files: FileState[]): Record<SyncState, number> {
  const counts: Record<SyncState, number> = {
    "in-sync": 0,
    "local-changed": 0,
    "muse-changed": 0,
    conflict: 0,
  };
  for (const file of files) counts[file.state] += 1;
  return counts;
}
