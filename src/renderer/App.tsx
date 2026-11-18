import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { List, ListItem } from "@astryxdesign/core/List";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { FileBridge } from "@shared/bridge";
import {
  buildContextPack,
  buildRelevantFilesBlock,
  contextSignature,
} from "@shared/contextPack";
import { diffLines } from "@shared/diff";
import { latestFileRequest } from "@shared/fileRequest";
import { buildFileTree, countByState, type FileTreeNode } from "@shared/fileTree";
import { GENERIC_PROFILE, resolveProfile } from "@shared/profile";
import type {
  AgentProfile,
  ContextFile,
  FileState,
  Project,
  ProjectKnowledge,
  ReconcileResult,
  ScanResult,
  SkipReason,
  SyncDirection,
  SyncState,
} from "@shared/types";
import {
  bindableChatUrl,
  chatPartitionForOwner,
  GENERAL_CHAT_OWNER,
  GO_TO_NEW_THREAD_SCRIPT,
  initialChatUrl,
  isMainChatUrl,
  isNewThreadUrl,
  MUSE_HOME_URL,
  museWorkFolder,
  RENAME_THREAD_SCRIPT,
  threadNameForProject,
} from "@shared/chatSession";
import { isMuseLoggedIn, type MusePageSignals } from "@shared/museAuth";
import { getBridge, isElectron } from "./bridge";

const bridge: FileBridge = getBridge();

const STATE_LABELS: Record<SyncState, string> = {
  "in-sync": "In sync",
  "local-changed": "Local changed",
  "muse-changed": "Muse changed",
  conflict: "Conflict",
};

// Color is reserved for state meaning: neutral for in sync, blue for a local
// change, amber (yellow) for Muse-side changes waiting on approval, red
// only for a conflict.
const STATE_VARIANTS: Record<SyncState, "neutral" | "blue" | "yellow" | "red"> = {
  "in-sync": "neutral",
  "local-changed": "blue",
  "muse-changed": "yellow",
  conflict: "red",
};

const CLASS_LABELS: Record<string, string> = {
  text: "Text",
  "readable-binary": "Readable binary",
  "opaque-binary": "Opaque binary",
  directory: "Folder",
};

const REASON_LABELS: Record<SkipReason, string> = {
  binary: "Binary file",
  junk: "Junk",
  size: "Over the 5 MB limit",
  gitignore: "Matched by .gitignore",
  deep: "In a subfolder",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function StateBadge({
  state,
  testId,
  path,
}: {
  state: SyncState;
  testId?: string;
  path?: string;
}) {
  return (
    <Badge
      variant={STATE_VARIANTS[state]}
      label={STATE_LABELS[state]}
      data-testid={testId}
      data-path={path}
    />
  );
}

// Orchestrator page scripts, run inside a project's muse.ai webview.
// The composer script types the question and sends it; the read script
// takes whatever answer text follows the question on the page. Both are
// best-effort against a page the app does not control: callers treat a
// failure as "open the project chat instead", never as a lost question.
const SEND_QUESTION_SCRIPT = `(async (q) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const findComposer = () =>
    document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
  const composer = findComposer();
  if (!composer) return { sent: false, detail: "no message box found" };
  composer.focus();
  if (composer.tagName === "TEXTAREA" || composer.tagName === "INPUT") {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(composer), "value")?.set;
    if (setter) setter.call(composer, q); else composer.value = q;
    composer.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, q);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
  }
  await sleep(300);
  const sendButton = [...document.querySelectorAll("button")].find((b) =>
    /send/i.test(b.getAttribute("aria-label") ?? "") || /send/i.test(b.textContent ?? ""),
  );
  if (sendButton) sendButton.click();
  else {
    for (const type of ["keydown", "keypress", "keyup"]) {
      composer.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }
  await sleep(600);
  const after = findComposer();
  const remaining = after ? (("value" in after ? after.value : after.textContent) ?? "").trim() : "";
  return { sent: remaining === "" || Boolean(sendButton), detail: remaining === "" ? "sent" : "typed" };
})`;

const COMPOSER_READY_SCRIPT = `Boolean(document.querySelector('textarea, [contenteditable="true"], [role="textbox"]'))`;

// The tail of the chat page text, scanned for the agent's file requests.
const CHAT_TEXT_SCRIPT = `(document.body?.innerText ?? "").slice(-30000)`;

// Runs inside the muse.ai page in the webview and reports what is on it.
// The login form, a chat composer, and signed-in app chrome are mutually
// exclusive enough to tell whether the user is signed in.
const MUSE_PAGE_PROBE = `(() => {
  const text = (document.body?.innerText ?? "").toLowerCase();
  return {
    url: location.href,
    hasLoginForm:
      text.includes("log in or create an account") ||
      text.includes("continue with facebook") ||
      text.includes("mobile number or email"),
    hasComposer: !!document.querySelector('textarea, [contenteditable="true"], [role="textbox"]'),
    hasAppShell:
      text.includes("log out") || text.includes("new chat") || text.includes("main chat"),
    viewWidth: innerWidth,
    viewHeight: innerHeight,
  };
})()`;

interface WebviewElement extends HTMLElement {
  executeJavaScript: (code: string) => Promise<unknown>;
}

function ChatSurface({
  owner,
  project,
  hidden,
  onAuthChange,
  onWebview,
  onChatUrl,
  onNewChatFailed,
  onChatNamed,
}: {
  owner: string;
  project: Project | null;
  hidden: boolean;
  onAuthChange: (owner: string, loggedIn: boolean) => void;
  onWebview?: (owner: string, webview: WebviewElement | null) => void;
  onChatUrl?: (owner: string, chatUrl: string) => void;
  onNewChatFailed?: (owner: string) => void;
  onChatNamed?: (owner: string, name: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const partition = chatPartitionForOwner(owner);
  // Captured at mount: General loads the main chat; a project loads its
  // own bound thread, or Muse's new-thread route when it has none yet —
  // never the main chat, where the previously selected conversation
  // would show. Remounting on every binding update would reload the
  // page mid-conversation, so this stays fixed for the surface's life.
  const startUrl = useRef(
    owner === GENERAL_CHAT_OWNER ? MUSE_HOME_URL : initialChatUrl(project),
  ).current;
  const boundChatUrl = useRef<string | null>(bindableChatUrl(project?.isolatedChatUrl));
  boundChatUrl.current = bindableChatUrl(project?.isolatedChatUrl);
  // New-thread state for an unbound project: how many times we had to
  // send the page to /thread/new, and whether failure was reported.
  // Retried on every probe — a single early attempt races the page load
  // and must not be the only one.
  const newThreadNavs = useRef(0);
  const lastNewThreadNav = useRef(0);
  const newChatFailureReported = useRef(false);
  const probing = useRef(false);
  // Thread naming: the key is bound thread + desired name, so a rename
  // is attempted for each distinct thread and retried a few times
  // (Muse's sidebar renders lazily), then left alone.
  const projectName = useRef(project?.name ?? "");
  projectName.current = project?.name ?? "";
  const naming = useRef({ key: "", attempts: 0, last: 0, done: false });
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    host.replaceChildren();
    if (!isElectron()) {
      const frame = document.createElement("iframe");
      frame.src = startUrl;
      frame.title = "Muse chat";
      host.append(frame);
      // Browser mode has no real Muse session (mock bridge); the pane is
      // not gated there.
      onAuthChange(owner, true);
      return () => host.replaceChildren();
    }
    const webview = document.createElement("webview") as unknown as WebviewElement;
    webview.setAttribute("src", startUrl);
    // Each chat owner gets its own persistent partition, so one
    // project's chat state can never leak into another's or General's.
    // Popups stay allowed, or provider login (Facebook/Google/Apple)
    // silently does nothing and its cookies do not survive the round-trip.
    webview.setAttribute("partition", partition);
    webview.setAttribute("allowpopups", "true");
    let cancelled = false;
    // The guest page can get stuck at its 150px default height even
    // though the element fills the pane (it syncs its size only when the
    // element is laid out again). Toggling display forces the resync.
    const resyncGuestSize = (): void => {
      webview.style.display = "none";
      requestAnimationFrame(() => {
        webview.style.display = "";
      });
    };
    const probe = async (): Promise<void> => {
      if (probing.current) return;
      probing.current = true;
      try {
        const signals = (await webview.executeJavaScript(MUSE_PAGE_PROBE)) as MusePageSignals;
        if (cancelled) return;
        const loggedIn = isMuseLoggedIn(signals);
        onAuthChange(owner, loggedIn);
        if (owner !== GENERAL_CHAT_OWNER) {
          const currentUrl = bindableChatUrl(signals.url);
          if (boundChatUrl.current) {
            // This project has its own thread: keep the binding in step
            // with it, and never start a second new thread over it.
            if (currentUrl && currentUrl !== boundChatUrl.current) {
              onChatUrl?.(owner, currentUrl);
            }
            // And make sure that thread carries the project's name in
            // Muse's chat list.
            const name = threadNameForProject({ name: projectName.current });
            const key = `${boundChatUrl.current}|${name}`;
            if (naming.current.key !== key) {
              naming.current = { key, attempts: 0, last: 0, done: false };
            }
            const nowMs = Date.now();
            if (
              projectName.current !== "" &&
              !naming.current.done &&
              naming.current.attempts < 6 &&
              nowMs - naming.current.last > 3000
            ) {
              naming.current.attempts += 1;
              naming.current.last = nowMs;
              const result = (await webview
                .executeJavaScript(
                  `${RENAME_THREAD_SCRIPT}(${JSON.stringify(name)})`,
                )
                .catch(() => null)) as { state?: string } | null;
              if (result?.state === "renamed" || result?.state === "already") {
                naming.current.done = true;
                if (result.state === "renamed") onChatNamed?.(owner, name);
              } else if (naming.current.attempts >= 6) {
                naming.current.done = true;
              }
            }
          } else if (currentUrl && !isMainChatUrl(signals.url)) {
            // A real thread appeared on a surface that loaded
            // /thread/new: it is the thread started for this project.
            boundChatUrl.current = currentUrl;
            onChatUrl?.(owner, currentUrl);
          } else if (
            loggedIn &&
            !isNewThreadUrl(signals.url) &&
            signals.url.startsWith("https://muse.ai")
          ) {
            // Unbound, and the page is somewhere that is not the new
            // thread (the main chat, or an old conversation Muse
            // restored): send it to /thread/new, retrying on later
            // probes instead of giving up after one attempt.
            const now = Date.now();
            if (newThreadNavs.current >= 5) {
              if (!newChatFailureReported.current) {
                newChatFailureReported.current = true;
                onNewChatFailed?.(owner);
              }
            } else if (now - lastNewThreadNav.current > 2000) {
              newThreadNavs.current += 1;
              lastNewThreadNav.current = now;
              await webview.executeJavaScript(GO_TO_NEW_THREAD_SCRIPT).catch(() => {});
            }
          }
        }
        if (
          host.clientWidth > 2 &&
          host.clientHeight > 2 &&
          signals.viewWidth !== undefined &&
          signals.viewHeight !== undefined &&
          (Math.abs(signals.viewWidth - host.clientWidth) > 2 ||
            Math.abs(signals.viewHeight - host.clientHeight) > 2)
        ) {
          resyncGuestSize();
        }
      } catch {
        // Webview not ready yet; the next event or poll retries.
      } finally {
        probing.current = false;
      }
    };
    webview.addEventListener("dom-ready", resyncGuestSize);
    const onEvent = (): void => void probe();
    for (const event of ["dom-ready", "did-finish-load", "did-navigate", "did-navigate-in-page"]) {
      webview.addEventListener(event, onEvent);
    }
    const poll = setInterval(onEvent, 2000);
    host.append(webview);
    onWebview?.(owner, webview);
    return () => {
      cancelled = true;
      onWebview?.(owner, null);
      clearInterval(poll);
      for (const event of ["dom-ready", "did-finish-load", "did-navigate", "did-navigate-in-page"]) {
        webview.removeEventListener(event, onEvent);
      }
      webview.removeEventListener("dom-ready", resyncGuestSize);
      webview.remove();
    };
  }, [onAuthChange, onChatNamed, onChatUrl, onNewChatFailed, onWebview, owner, partition, startUrl]);
  // Coming back to a kept-alive chat: the hidden guest may have lost its
  // size sync, so force the same resync the load path uses.
  useEffect(() => {
    if (hidden) return;
    const webview = ref.current?.querySelector<HTMLElement>("webview");
    if (!webview) return;
    webview.style.display = "none";
    requestAnimationFrame(() => {
      webview.style.display = "";
    });
  }, [hidden]);
  return (
    <div
      className="chat-surface"
      ref={ref}
      data-testid="chat-surface"
      data-owner={owner}
      data-partition={partition}
      data-chat-url={startUrl}
      data-work-folder={project ? museWorkFolder(project) : undefined}
      data-thread-name={project ? threadNameForProject(project) : undefined}
      style={hidden ? { display: "none" } : undefined}
    />
  );
}

interface SaveBackEntry {
  file: FileState;
  local: string | null;
  muse: string | null;
}

function DiffView({ local, muse }: { local: string | null; muse: string | null }) {
  if (local === null || muse === null) {
    return <Text type="supporting">Binary file: content is not shown.</Text>;
  }
  return (
    <div className="diff">
      {diffLines(local, muse).map((line, index) => (
        <div key={index} className={line.kind === "same" ? undefined : `line-${line.kind}`}>
          {`${line.kind === "local" ? "- " : line.kind === "muse" ? "+ " : "  "}${line.text}`}
        </div>
      ))}
    </div>
  );
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [results, setResults] = useState<Map<string, ReconcileResult>>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [projectsOpen, setProjectsOpen] = useState(true);
  // No projects are shown until the embedded Muse page reports a
  // signed-in session. Browser mode has no real session and is not gated.
  const [museLoggedIn, setMuseLoggedIn] = useState(() => !isElectron());
  // One chat session per owner: General plus each project ever opened in
  // this run. Visited chats stay mounted (hidden) so switching projects
  // switches conversations without losing or mixing them.
  const [visitedOwners, setVisitedOwners] = useState<ReadonlySet<string>>(
    () => new Set(["general"]),
  );

  const [scanOpen, setScanOpen] = useState(false);
  const [scanProject_, setScanProject] = useState<Project | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanStatus, setScanStatus] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [syncOpen, setSyncOpen] = useState(false);
  const [syncEntries, setSyncEntries] = useState<SaveBackEntry[]>([]);
  const [directions, setDirections] = useState<Map<string, SyncDirection>>(new Map());

  // Goal/soul/decisions/memory still live in the project's .parnassus
  // files and still go to its chat in the context pack; they are just
  // not displayed or edited in the side pane anymore.
  const [genericProfile, setGenericProfileState] = useState<AgentProfile>({
    ...GENERIC_PROFILE,
  });

  const selectedProject = projects.find((p) => p.id === selectedId);
  const selectedResult = selectedId ? results.get(selectedId) : undefined;
  const webviewByOwner = useRef(new Map<string, WebviewElement>());
  const registerWebview = useCallback((owner: string, webview: WebviewElement | null) => {
    if (webview) webviewByOwner.current.set(owner, webview);
    else webviewByOwner.current.delete(owner);
  }, []);

  // Only General's sign-in state gates the project list: a project's own
  // isolated chat signing in (or not yet) must not hide every project.
  const handleAuthChange = useCallback((owner: string, loggedIn: boolean) => {
    if (loggedIn) setMuseLoggedIn(true);
    else if (owner === GENERAL_CHAT_OWNER) setMuseLoggedIn(false);
  }, []);

  const projectsRef = useRef<Project[]>([]);
  projectsRef.current = projects;
  const handleNewChatFailed = useCallback((owner: string) => {
    const name = projectsRef.current.find((p) => p.id === owner)?.name ?? "this project";
    setStatus(
      `Could not start a new chat for ${name} — it is showing an existing conversation. Use Muse's new-chat control in the chat pane once, and this project will keep that thread.`,
    );
  }, []);

  const handleChatNamed = useCallback((owner: string, name: string) => {
    void owner;
    setStatus(`Named this project's chat "${name}" in Muse's chat list.`);
  }, []);

  const boundChatUrls = useRef(new Map<string, string>());
  const handleChatUrl = useCallback((owner: string, chatUrl: string) => {
    const bound = bindableChatUrl(chatUrl);
    if (!bound || boundChatUrls.current.get(owner) === bound) return;
    boundChatUrls.current.set(owner, bound);
    void bridge
      .setProjectChatUrl(owner, bound)
      .then((updated) => {
        setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      })
      .catch(() => {
        boundChatUrls.current.delete(owner);
      });
  }, []);

  // Each project's .parnassus knowledge, read for its context pack.
  const [orchKnowledge, setOrchKnowledge] = useState<Map<string, ProjectKnowledge>>(new Map());

  useEffect(() => {
    void (async () => {
      const loaded = new Map<string, ProjectKnowledge>();
      for (const project of projects) {
        try {
          loaded.set(project.id, await bridge.getProjectKnowledge(project.id));
        } catch {
          // A project without readable knowledge still routes by name/goal.
        }
      }
      setOrchKnowledge(loaded);
    })();
  }, [projects]);

  async function waitForWebview(owner: string): Promise<WebviewElement | null> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const webview = webviewByOwner.current.get(owner);
      if (webview) {
        try {
          if (await webview.executeJavaScript(COMPOSER_READY_SCRIPT)) return webview;
        } catch {
          // Not loaded yet.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return webviewByOwner.current.get(owner) ?? null;
  }

  const [sentSignatures, setSentSignatures] = useState<Record<string, string>>({});
  const [ctxBusy, setCtxBusy] = useState(false);
  // The file-request loop: watch the selected project's chat for the
  // agent's PARNASSUS_FILE_REQUEST marker and answer it with the file.
  const [fileLoopOn, setFileLoopOn] = useState(true);
  const handledLoopRequests = useRef(new Set<string>());
  const loopBusy = useRef(false);

  async function loadContextPack(
    projectId: string,
  ): Promise<{
    projectId: string;
    pack: string;
    signature: string;
    files: ContextFile[];
  } | null> {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return null;
    try {
      const files = await bridge.describeFiles(projectId);
      const effective = resolveProfile(project, genericProfile);
      const pack = buildContextPack({
        projectName: project.name,
        goal: effective.goal,
        soul: effective.soul,
        memory: orchKnowledge.get(projectId)?.memory ?? null,
        files,
        rootPath: project.rootPath,
        stagedPath: project.stagedPath,
        workFolder: museWorkFolder(project),
      });
      return { projectId, pack, signature: contextSignature(pack), files };
    } catch {
      return null;
    }
  }

  async function sendContextToChat(): Promise<void> {
    if (!selectedProject || ctxBusy) return;
    const built = await loadContextPack(selectedProject.id);
    if (!built) return;
    if (!isElectron()) {
      setStatus("File context can only be sent to a chat in the desktop app.");
      return;
    }
    setCtxBusy(true);
    try {
      const webview = await waitForWebview(selectedProject.id);
      if (!webview) throw new Error("chat not ready");
      const sent = (await webview.executeJavaScript(
        `${SEND_QUESTION_SCRIPT}(${JSON.stringify(
          `${built.pack}\n\nThese are the files for this project. Keep them in mind for this chat; I will ask about them next.`,
        )})`,
      )) as { sent: boolean };
      if (!sent.sent) throw new Error("could not send");
      setSentSignatures((prev) => ({ ...prev, [selectedProject.id]: built.signature }));
      setStatus(`Sent the file context to the ${selectedProject.name} chat.`);
    } catch {
      setStatus("Could not send the file context — open the project chat and try again.");
    }
    setCtxBusy(false);
  }

  // Sends one staged file's full content into a project's chat.
  // Returns false when the file has no sendable text or the chat is
  // not reachable, so the file-request loop can report it and stop.
  async function deliverFileToChat(projectId: string, path: string): Promise<boolean> {
    const content = await bridge.readFile(projectId, path, "muse");
    if (content === null) return false;
    const webview = await waitForWebview(projectId);
    if (!webview) return false;
    const block = buildRelevantFilesBlock([{ path, content }]);
    const sent = (await webview.executeJavaScript(
      `${SEND_QUESTION_SCRIPT}(${JSON.stringify(
        `Here is the full content of the file you requested:\n\n${block}\n\nNow answer the original question using this file. If you still need another file, request it the same way.`,
      )})`,
    )) as { sent: boolean };
    return sent.sent;
  }

  // Tier two of the context: the chat got summaries with the pack, and
  // a file's full content is sent only when it is actually needed — the
  // agent names it, the user sends it from the tree.
  async function sendFileToChat(path: string): Promise<void> {
    if (!selectedProject || ctxBusy) return;
    if (!isElectron()) {
      setStatus("Files can only be sent to a chat in the desktop app.");
      return;
    }
    setCtxBusy(true);
    try {
      const sent = await deliverFileToChat(selectedProject.id, path);
      if (!sent) throw new Error("could not send");
      setStatus(`Sent the full content of ${path} to the ${selectedProject.name} chat.`);
    } catch {
      setStatus(`Could not send ${path} — open the project chat and try again.`);
    }
    setCtxBusy(false);
  }

  function renderTreeNodes(nodes: FileTreeNode[], depth: number) {
    return nodes.map((node) => (
      <VStack key={node.path} gap={0} paddingInlineStart={depth === 0 ? 0 : 3}>
        <ListItem
          label={
            <Text type="code" size="sm">
              {node.isFolder ? `${node.name}/` : node.name}
            </Text>
          }
          data-testid={node.isFolder ? "tree-folder" : "tree-file"}
          data-path={node.path}
          endContent={
            <HStack gap={2} vAlign="center">
              <StateBadge
                state={node.state}
                testId={node.isFolder ? "folder-state" : "file-state"}
                path={node.path}
              />
              {!node.isFolder && (
                <Button
                  label="Send to chat"
                  size="sm"
                  isDisabled={ctxBusy}
                  data-testid="send-file"
                  data-path={node.path}
                  onClick={() => void sendFileToChat(node.path)}
                />
              )}
            </HStack>
          }
        />
        {node.children.length > 0 && renderTreeNodes(node.children, depth + 1)}
      </VStack>
    ));
  }

  function renderFileTree() {
    if (!selectedProject || !selectedResult) return null;
    const counts = countByState(selectedResult.files);
    const notSynced =
      counts["local-changed"] + counts["muse-changed"] + counts.conflict;
    return (
      <VStack gap={2} data-testid="file-tree">
        <HStack hAlign="between" vAlign="center">
          <Heading level={3}>Files</Heading>
          <Text type="supporting" data-testid="sync-summary">
            {notSynced === 0
              ? `${counts["in-sync"]} synced`
              : `${counts["in-sync"]} synced · ${notSynced} not synced`}
          </Text>
        </HStack>
        {selectedResult.files.length === 0 ? (
          <Text type="supporting">No files copied in yet.</Text>
        ) : (
          <List density="compact" hasDividers>
            {renderTreeNodes(buildFileTree(selectedResult.files), 0)}
          </List>
        )}
      </VStack>
    );
  }

  function applyResult(result: ReconcileResult): void {
    setResults((prev) => new Map(prev).set(result.projectId, result));
  }

  async function selectProject(id: string | null, known?: ReconcileResult): Promise<void> {
    setSelectedId(id);
    if (!id) return;
    if (known) {
      applyResult(known);
      return;
    }
    try {
      // Opening a project always runs the three-way check first.
      applyResult(await bridge.reconcile(id));
    } catch (error) {
      setStatus(`Could not check the project: ${errorText(error)}`);
    }
  }

  async function onAddProject(): Promise<void> {
    setStatus("");
    let project: Project | null;
    try {
      project = await bridge.pickFolder();
    } catch (error) {
      setStatus(errorText(error));
      return;
    }
    if (!project) {
      setStatus("Add project cancelled.");
      return;
    }
    setScanProject(project);
    setScan(null);
    setSelected(new Set());
    setScanStatus(`Scanning ${project.rootPath} ...`);
    setScanOpen(true);
    try {
      const result = await bridge.scanProject(project);
      setScan(result);
      // Copyable files start ticked; skipped files and subfolders start
      // unticked. Nothing is copied unless its tick is on at copy-in.
      setSelected(new Set(result.files.map((f) => f.path)));
      setScanStatus(
        `${project.name}: ${result.files.length} files found, ${result.skipped.length} skipped. Tick the files to add.`,
      );
    } catch (error) {
      setScanStatus(`Scan failed: ${errorText(error)}`);
    }
  }

  async function onCopyIn(): Promise<void> {
    if (!scan || !scanProject_) return;
    try {
      const result = await bridge.copyIn(scanProject_, [...selected]);
      setScanOpen(false);
      // Re-read the project so it carries its staging folder and any
      // bound chat URL the bridge now holds for it.
      const listed = await bridge.listProjects().catch(() => [] as Project[]);
      const fresh = listed.find((p) => p.id === scanProject_.id) ?? scanProject_;
      setProjects((prev) =>
        prev.some((p) => p.id === fresh.id)
          ? prev.map((p) => (p.id === fresh.id ? fresh : p))
          : [...prev, fresh],
      );
      setStatus(
        `Copied in ${result.files.length} files from ${scanProject_.name}. State: ${STATE_LABELS[result.state]}.`,
      );
      await selectProject(scanProject_.id, result);
    } catch (error) {
      setScanStatus(`Copy in failed: ${errorText(error)}`);
    }
  }

  function setSelectedPath(path: string, included: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (included) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  function includeAllWithReason(reason: SkipReason): void {
    if (!scan) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const item of scan.skipped) {
        if (item.reason === reason) next.add(item.path);
      }
      return next;
    });
  }

  async function openSync(projectId: string): Promise<void> {
    let result: ReconcileResult;
    try {
      result = await bridge.reconcile(projectId);
    } catch (error) {
      setStatus(errorText(error));
      return;
    }
    applyResult(result);
    const changed = result.files.filter((f) => f.state !== "in-sync");
    const entries: SaveBackEntry[] = [];
    for (const file of changed) {
      const [local, muse] = await Promise.all([
        bridge.readFile(projectId, file.path, "local"),
        bridge.readFile(projectId, file.path, "muse"),
      ]);
      entries.push({ file, local, muse });
    }
    setSyncEntries(entries);
    // One-sided changes get their only sensible direction preselected;
    // a conflict has no default — the user must pick per file.
    const defaults = new Map<string, SyncDirection>();
    for (const file of changed) {
      if (file.state === "muse-changed") defaults.set(file.path, "to-local");
      else if (file.state === "local-changed") defaults.set(file.path, "to-muse");
    }
    setDirections(defaults);
    setSyncOpen(true);
  }

  const unresolvedSync = (selectedResult?.files ?? []).filter(
    (f) => f.state !== "in-sync" && !directions.has(f.path),
  );

  async function onApproveSync(): Promise<void> {
    if (!selectedId) return;
    if (unresolvedSync.length > 0) {
      setStatus("Choose a direction for every changed file before applying.");
      return;
    }
    try {
      const outcome = await bridge.applySync(selectedId, Object.fromEntries(directions));
      applyResult(outcome.result);
      setSyncOpen(false);
      const parts: string[] = [];
      if (outcome.appliedToLocal.length > 0) {
        parts.push(`Muse → my files: ${outcome.appliedToLocal.join(", ")}`);
      }
      if (outcome.appliedToMuse.length > 0) {
        parts.push(`My files → Muse: ${outcome.appliedToMuse.join(", ")}`);
      }
      if (outcome.blocked.length > 0) {
        parts.push(`Still blocked: ${outcome.blocked.join(", ")}`);
      }
      setStatus(
        `${parts.length > 0 ? parts.join(". ") : "Nothing to apply."} Check whether .parnassus/decisions.md or .parnassus/memory.md need updating after this change.`,
      );
    } catch (error) {
      setStatus(errorText(error));
    }
  }

  useEffect(() => {
    const key = selectedId ?? "general";
    setVisitedOwners((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, [selectedId]);

  useEffect(() => {
    void (async () => {
      try {
        setGenericProfileState(await bridge.getGenericProfile());
        const list = await bridge.listProjects();
        setProjects(list);
        const fresh = new Map<string, ReconcileResult>();
        for (const project of list) {
          fresh.set(project.id, await bridge.reconcile(project.id));
        }
        setResults(fresh);
      } catch (error) {
        setStatus(errorText(error));
      }
    })();
  }, []);

  // While a project is open its knowledge files are re-read from disk
  // every few seconds, so edits made in a text editor are picked up by
  // the next context pack sent to its chat.
  useEffect(() => {
    if (!selectedId) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const fresh = await bridge.getProjectKnowledge(selectedId);
          setOrchKnowledge((prev) => {
            const current = prev.get(selectedId);
            if (current && current.decisions === fresh.decisions && current.memory === fresh.memory) {
              return prev;
            }
            return new Map(prev).set(selectedId, fresh);
          });
        } catch {
          // Project went away; the next selection reloads anyway.
        }
      })();
    }, 5000);
    return () => clearInterval(timer);
  }, [selectedId]);

  // File-request loop: while a project chat is open, scan its page for
  // the agent's file request, send that staged file in, and let it
  // answer. Each request (by position in the conversation) is answered
  // once; a later request for the same file is a new round and answered
  // again. Only files copied in for this project can be requested.
  useEffect(() => {
    if (!selectedId || !fileLoopOn || !isElectron()) return;
    const projectId = selectedId;
    const timer = setInterval(() => {
      void (async () => {
        if (loopBusy.current) return;
        const webview = webviewByOwner.current.get(projectId);
        if (!webview) return;
        loopBusy.current = true;
        try {
          const text = (await webview.executeJavaScript(CHAT_TEXT_SCRIPT)) as string;
          const request = latestFileRequest(text);
          if (!request) return;
          const key = `${projectId}|${request.occurrence}|${request.path}`;
          if (handledLoopRequests.current.has(key)) return;
          handledLoopRequests.current.add(key);
          const files = await bridge.describeFiles(projectId).catch(() => [] as ContextFile[]);
          if (!files.some((file) => file.path === request.path)) {
            setStatus(
              `The chat asked for ${request.path}, which is not copied in for this project — the request was not answered.`,
            );
            return;
          }
          const sent = await deliverFileToChat(projectId, request.path).catch(() => false);
          setStatus(
            sent
              ? `File loop: sent ${request.path} to the chat, so it can answer with the file.`
              : `File loop: could not send ${request.path} to the chat.`,
          );
        } catch {
          // Chat not ready yet; the next tick retries.
        } finally {
          loopBusy.current = false;
        }
      })();
    }, 3000);
    return () => clearInterval(timer);
    // deliverFileToChat/waitForWebview are stable enough for this timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, fileLoopOn]);

  const skipReasons = scan ? [...new Set(scan.skipped.map((s) => s.reason))] : [];

  return (
    <div className="app-frame">
      <div className="app-main">
        <section className="chat-region" aria-label="Chat">
          <HStack className="chat-header" gap={3} vAlign="center" padding={3} paddingInline={4}>
            <Heading level={1}>Parnassus</Heading>
            <HStack gap={2} vAlign="center">
              <Text type="supporting">Context:</Text>
              <HStack data-testid="context-label">
                <Text type="code">{selectedProject ? selectedProject.name : "General"}</Text>
              </HStack>
            </HStack>
            {museLoggedIn ? (
              <Button
                label={projectsOpen ? "Hide projects" : "Show projects"}
                size="sm"
                data-testid="toggle-projects"
                onClick={() => setProjectsOpen((open) => !open)}
              />
            ) : (
              <Text type="supporting" data-testid="login-required">
                Sign in to Muse — your projects will appear here after login.
              </Text>
            )}
          </HStack>
          <HStack className="chat-tabs" gap={2} vAlign="center" padding={2} paddingInline={4} wrap="wrap">
            <Button
              label="General"
              size="sm"
              variant={selectedId === null ? "primary" : undefined}
              data-testid="chat-tab"
              data-owner="general"
              onClick={() => void selectProject(null)}
            />
            {museLoggedIn &&
              projects.map((project) => (
                <Button
                  key={project.id}
                  label={project.name}
                  size="sm"
                  variant={selectedId === project.id ? "primary" : undefined}
                  data-testid="chat-tab"
                  data-owner={project.id}
                  onClick={() => void selectProject(project.id)}
                />
              ))}
          </HStack>
          {[...visitedOwners].map((owner) => (
            <ChatSurface
              key={owner}
              owner={owner}
              project={projects.find((p) => p.id === owner) ?? null}
              hidden={owner !== (selectedId ?? "general")}
              onAuthChange={handleAuthChange}
              onWebview={registerWebview}
              onChatUrl={handleChatUrl}
              onNewChatFailed={handleNewChatFailed}
              onChatNamed={handleChatNamed}
            />
          ))}
        </section>

        {museLoggedIn && projectsOpen && (
        <aside className="side-region" aria-label="Projects">
          <VStack gap={3} padding={4}>
            <HStack hAlign="between" vAlign="center">
              <Heading level={2}>Projects</Heading>
              <Button
                label="Add project"
                size="sm"
                data-testid="add-project"
                onClick={() => void onAddProject()}
              />
            </HStack>

            <List density="compact">
              <ListItem
                label="General chat"
                description="no project files in reach"
                isSelected={selectedId === null}
                onClick={() => void selectProject(null)}
                data-testid="general-row"
              />
            </List>

            {projects.length === 0 ? (
              <EmptyState
                id="projects-empty"
                title="No projects yet"
                description="Add a project to copy a folder in."
              />
            ) : (
              <List density="compact" hasDividers data-testid="project-list">
                {projects.map((project) => {
                  const result = results.get(project.id);
                  return (
                    <ListItem
                      key={project.id}
                      label={project.name}
                      description={
                        <Text type="code" size="sm">
                          {project.rootPath}
                        </Text>
                      }
                      isSelected={project.id === selectedId}
                      onClick={() => void selectProject(project.id)}
                      data-testid="project-row"
                      data-project-id={project.id}
                      endContent={
                        result ? (
                          <StateBadge state={result.state} testId="project-badge" />
                        ) : undefined
                      }
                    />
                  );
                })}
              </List>
            )}

            {selectedProject && selectedResult && (
              <VStack gap={2}>
                <HStack hAlign="between" vAlign="center">
                  <Heading level={3}>{selectedProject.name}</Heading>
                  <StateBadge state={selectedResult.state} testId="project-state" />
                </HStack>
                <Text type="code" size="sm" color="secondary">
                  {selectedProject.rootPath}
                </Text>
                <HStack gap={2} wrap="wrap">
                  <Button
                    label="Recheck"
                    size="sm"
                    data-testid="recheck"
                    onClick={() => void selectProject(selectedProject.id)}
                  />
                  <Button
                    label={
                      sentSignatures[selectedProject.id] === undefined
                        ? "Send file context"
                        : "Resend context"
                    }
                    size="sm"
                    isDisabled={ctxBusy}
                    data-testid="send-context"
                    onClick={() => void sendContextToChat()}
                  />
                  <Button
                    label={fileLoopOn ? "File loop: on" : "File loop: off"}
                    size="sm"
                    variant={fileLoopOn ? "primary" : undefined}
                    data-testid="file-loop-toggle"
                    onClick={() => setFileLoopOn((on) => !on)}
                  />
                  {selectedResult.state !== "in-sync" && (
                    <Button
                      label="Check & apply changes"
                      variant="primary"
                      size="sm"
                      data-testid="open-sync"
                      onClick={() => void openSync(selectedProject.id)}
                    />
                  )}
                </HStack>
                {renderFileTree()}
              </VStack>
            )}
          </VStack>
        </aside>
        )}
      </div>

      <HStack className="status-bar" role="status" data-testid="status-line">
        <Text type="supporting">{status}</Text>
      </HStack>

      <Dialog
        id="scan-dialog"
        isOpen={scanOpen}
        onOpenChange={(open) => setScanOpen(open)}
        purpose="form"
        width={680}
        maxHeight="92dvh">
        <DialogHeader title="Add project" />
        <VStack className="dialog-body" gap={3} paddingBlockStart={3}>
          <Text type="supporting">{scanStatus}</Text>
          {scan && (
            <>
              <Text type="supporting">
                Copying in runs through the Airlock: files are copied to the Muse side,
                and your originals stay untouched until an approved save back.
              </Text>
              <Heading level={3}>Files — tick the ones to add</Heading>
              <Text type="supporting">
                Only ticked files are copied in. Adding the folder by itself copies
                nothing.
              </Text>
              <List density="compact" data-testid="scan-files">
                {scan.files.map((file) => (
                  <ListItem
                    key={file.path}
                    label={file.path}
                    description={`${CLASS_LABELS[file.fileClass] ?? file.fileClass} · ${formatSize(file.size)}`}
                    startContent={
                      <CheckboxInput
                        label={file.path}
                        isLabelHidden
                        size="sm"
                        value={selected.has(file.path)}
                        onChange={(checked) => setSelectedPath(file.path, checked)}
                        data-testid="file-toggle"
                        data-path={file.path}
                      />
                    }
                  />
                ))}
                {scan.files.length === 0 && <ListItem label="No files found." />}
              </List>
              <Heading level={3}>Skipped</Heading>
              <Text type="supporting">
                Skipped files stay out of the copy. Tick one to include it anyway.
              </Text>
              <HStack gap={2} wrap="wrap">
                {skipReasons.map((reason) => (
                  <Button
                    key={reason}
                    label={`Include all: ${REASON_LABELS[reason]}`}
                    size="sm"
                    data-testid={`include-all-${reason}`}
                    onClick={() => includeAllWithReason(reason)}
                  />
                ))}
              </HStack>
              <List density="compact" data-testid="skipped-list">
                {scan.skipped.map((item) => (
                  <ListItem
                    key={item.path}
                    label={item.path}
                    description={`${REASON_LABELS[item.reason]} · ${CLASS_LABELS[item.fileClass] ?? item.fileClass} · ${formatSize(item.size)}`}
                    startContent={
                      <CheckboxInput
                        label={item.path}
                        isLabelHidden
                        size="sm"
                        value={selected.has(item.path)}
                        onChange={(checked) => setSelectedPath(item.path, checked)}
                        data-testid="skip-toggle"
                        data-path={item.path}
                      />
                    }
                  />
                ))}
                {scan.skipped.length === 0 && <ListItem label="Nothing was skipped." />}
              </List>
              <Heading level={3}>Subfolders, listed only</Heading>
              <Text type="supporting">
                Subfolders are not copied until you ask. Tick one to copy it whole.
              </Text>
              <List density="compact" data-testid="deep-list">
                {scan.deepDirs.map((dir) => (
                  <ListItem
                    key={dir.path}
                    label={`${dir.path}/`}
                    description={`${dir.fileCount} files, not copied yet`}
                    startContent={
                      <CheckboxInput
                        label={dir.path}
                        isLabelHidden
                        size="sm"
                        value={selected.has(dir.path)}
                        onChange={(checked) => setSelectedPath(dir.path, checked)}
                        data-testid="deep-toggle"
                        data-path={dir.path}
                      />
                    }
                  />
                ))}
                {scan.deepDirs.length === 0 && <ListItem label="No subfolders." />}
              </List>
            </>
          )}
        </VStack>
        <HStack className="dialog-footer" gap={2} hAlign="end">
          <Button label="Cancel" onClick={() => setScanOpen(false)} />
          <Button
            label={scan ? `Copy in ticked files (${selected.size})` : "Copy in ticked files"}
            variant="primary"
            isDisabled={!scan || selected.size === 0}
            data-testid="copy-in"
            onClick={() => void onCopyIn()}
          />
        </HStack>
      </Dialog>

      <Dialog
        id="sync-dialog"
        isOpen={syncOpen}
        onOpenChange={(open) => setSyncOpen(open)}
        purpose="form"
        width={680}
        maxHeight="92dvh">
        <DialogHeader title="Check & apply changes" />
        <VStack className="dialog-body" gap={3} paddingBlockStart={3}>
          <Text type="supporting">
            Every differing file is listed with the difference. For each one you
            choose the direction: Muse → my files copies the Muse version into
            your folder; My files → Muse sends your version to the Muse side.
            Nothing moves in either direction until you approve.
          </Text>
          {syncEntries.length === 0 && <Text>Everything is in sync.</Text>}
          {syncEntries.map((entry) => (
            <VStack key={entry.file.path} gap={2} data-testid="sync-file" data-path={entry.file.path}>
              <HStack gap={2} vAlign="center">
                <Text type="code" weight="semibold">
                  {entry.file.path}
                </Text>
                <StateBadge state={entry.file.state} />
              </HStack>
              <DiffView local={entry.local} muse={entry.muse} />
              <RadioList
                label={`Direction for ${entry.file.path}`}
                isLabelHidden
                size="sm"
                value={directions.get(entry.file.path) ?? ""}
                onChange={(value) =>
                  setDirections((prev) => new Map(prev).set(entry.file.path, value as SyncDirection))
                }
                data-testid="sync-direction"
                data-path={entry.file.path}>
                <RadioListItem label="Use the Muse version → write to my files" value="to-local" />
                <RadioListItem label="Use my version → send to Muse" value="to-muse" />
              </RadioList>
            </VStack>
          ))}
          {unresolvedSync.length > 0 && (
            <Text data-testid="sync-blocked" weight="semibold">
              Choose a direction for every changed file before applying.
            </Text>
          )}
        </VStack>
        <HStack className="dialog-footer" gap={2} hAlign="end">
          <Button label="Cancel" onClick={() => setSyncOpen(false)} />
          <Button
            label="Approve and apply"
            variant="primary"
            isDisabled={unresolvedSync.length > 0}
            data-testid="approve-sync"
            onClick={() => void onApproveSync()}
          />
        </HStack>
      </Dialog>
    </div>
  );
}
