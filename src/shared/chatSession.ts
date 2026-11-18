// Per-project chat isolation for the embedded muse.ai view.
//
// Before this module every ChatSurface loaded https://muse.ai on the one
// shared "persist:muse" partition, so opening a project just showed the
// same (main) conversation as every other project. Isolation now has
// three parts, all keyed by the chat owner ("general" or a project id):
//
// 1. Its own Electron session partition, so cookies/local/session storage
//    for one project's chat can never bleed into another's.
// 2. Its own conversation: a project chat loads Muse's new-thread
//    route (/thread/new, from its own route table: chat "/", threadDraft
//    "/thread/new", thread "/thread/:sessionId") on first open, so it
//    starts as a fresh thread instead of the main/old chat at "/". Once
//    that draft becomes a real thread (/thread/<id>), the URL is bound
//    to the project (persisted via the bridge) and reloaded on reopen.
//    The main chat ("/", "/thread/main") and the draft route are never
//    bound to a project, and neither is a legacy `chatUrl` written before
//    isolation existed: those were whatever conversation was selected.
// 3. Its own folder: the context pack points the agent at the folder
//    holding this project's files (see contextPack.ts).

export const GENERAL_CHAT_OWNER = "general";
export const MUSE_HOME_URL = "https://muse.ai/";
// Muse's own new-thread route: opening it starts a fresh thread draft.
export const MUSE_NEW_THREAD_URL = "https://muse.ai/thread/new";

const AUTH_PATHS = ["/login", "/auth", "/signin", "/sign-in", "/signup", "/sign-up"];

function sanitizePartitionPart(owner: string): string {
  return owner.replace(/[^a-zA-Z0-9-]/g, "-");
}

// The Electron partition for one chat owner. General keeps the original
// shared sign-in partition; every project gets its own persistent one.
export function chatPartitionForOwner(owner: string): string {
  if (owner === GENERAL_CHAT_OWNER) return "persist:muse";
  return `persist:muse-${sanitizePartitionPart(owner)}`;
}

export function slugifyProjectName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "project" : slug;
}

// The folder the agent is told to use on its side for this project, and
// only this project. Deterministic per project, so the same chat always
// points at the same folder, and two projects never share one.
export function museWorkFolder(project: { id: string; name: string }): string {
  return `parnassus/projects/${slugifyProjectName(project.name)}-${sanitizePartitionPart(project.id)}`;
}

function museUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== "muse.ai" && !url.hostname.endsWith(".muse.ai")) return null;
    return url;
  } catch {
    return null;
  }
}

// Muse routes that must never be bound to a project: the main chat is
// shared by definition, and /thread/new is only a draft starter.
const NON_BINDABLE_PATHS = new Set(["/thread/new", "/thread/main"]);

function musePath(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  const url = museUrl(rawUrl);
  return url ? url.pathname.toLowerCase().replace(/\/+$/, "") || "/" : null;
}

export function isNewThreadUrl(rawUrl: string | null | undefined): boolean {
  return musePath(rawUrl) === "/thread/new";
}

// The shared main chat, however Muse routes to it.
export function isMainChatUrl(rawUrl: string | null | undefined): boolean {
  const path = musePath(rawUrl);
  return path === "/" || path === "/thread/main";
}

// A URL that names one specific conversation (not the main chat, not the
// new-thread draft, and not an auth page), so it can be bound to a single
// project and reloaded when that project is reopened.
export function bindableChatUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  const url = museUrl(rawUrl);
  if (!url) return null;
  const path = url.pathname.toLowerCase().replace(/\/+$/, "") || "/";
  if (AUTH_PATHS.some((auth) => path === auth || path.startsWith(`${auth}/`))) return null;
  if (NON_BINDABLE_PATHS.has(path)) return null;
  const hasConversationPath = path !== "/";
  const hasConversationQuery = ["chat", "conversation", "thread", "session"].some((key) =>
    url.searchParams.has(key),
  );
  if (!hasConversationPath && !hasConversationQuery) return null;
  return url.href;
}

// The URL a project's chat surface should load first: its own bound
// thread when it has one, otherwise a brand-new thread. General does not
// use this; it loads the main chat (MUSE_HOME_URL).
export function initialChatUrl(
  project: { isolatedChatUrl?: string | null } | null,
): string {
  return bindableChatUrl(project?.isolatedChatUrl) ?? MUSE_NEW_THREAD_URL;
}

// Runs inside the muse.ai page when a project chat landed somewhere
// other than its new thread (e.g. Muse redirected /thread/new to the
// main chat): go to the new-thread route. Retried by the caller, never
// assumed to have worked.
export const GO_TO_NEW_THREAD_SCRIPT = `location.assign("/thread/new")`;

// The name a project's chat carries in Muse's chat list: the project
// name itself, so the sidebar shows which project each chat belongs to.
export function threadNameForProject(project: { name: string }): string {
  const name = project.name.trim();
  return name === "" ? "Project chat" : name;
}

// Runs inside the muse.ai page: renames the current thread to the given
// name through Muse's own thread-options Rename dialog. Deliberately
// narrow — it clicks only the exact "rename" menu item and confirms
// only inside the dialog that opens, so it can never wander into the
// delete flow next to it. Returns a state string ("already", "renamed",
// or where it stopped); callers retry a few times and then leave the
// chat as it is rather than nagging.
export const RENAME_THREAD_SCRIPT = `(async (name) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s ?? "").replace(/\\s+/g, " ").trim().toLowerCase();
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const path = location.pathname.replace(/\\/+$/, "");
  const threadLinks = () =>
    [...document.querySelectorAll('a[href^="/thread/"]')].filter(
      (a) => (a.getAttribute("href") ?? "").replace(/\\/+$/, "") === path,
    );
  if (threadLinks().some((a) => norm(a.textContent) === norm(name))) {
    return { state: "already" };
  }
  const link = threadLinks()[0];
  const scopes = [];
  for (let el = link, depth = 0; el && depth < 5; depth++) {
    scopes.push(el);
    el = el.parentElement;
  }
  scopes.push(document.body);
  let options = null;
  for (const scope of scopes) {
    if (!scope || typeof scope.querySelectorAll !== "function") continue;
    options =
      [...scope.querySelectorAll('button, [role="button"]')].find((el) => {
        const label = norm(
          (el.getAttribute("aria-label") ?? "") + " " + (el.getAttribute("title") ?? ""),
        );
        return (
          visible(el) &&
          (label.includes("option") || label.includes("more actions") || label === "menu")
        );
      }) ?? null;
    if (options) break;
  }
  if (!options) return { state: "no-options" };
  options.click();
  await sleep(500);
  const menuItem = [
    ...document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="menu"] a'),
  ].find((el) => visible(el) && norm(el.textContent) === "rename");
  if (!menuItem) return { state: "no-rename-item" };
  menuItem.click();
  await sleep(500);
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return { state: "no-dialog" };
  const input = dialog.querySelector("input, textarea");
  if (!input) return { state: "no-input" };
  input.focus();
  if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    if (setter) setter.call(input, name);
    else input.value = name;
  } else {
    document.execCommand("selectAll", false);
    document.execCommand("insertText", false, name);
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(300);
  const confirm = [...dialog.querySelectorAll("button")].find(
    (el) =>
      visible(el) && ["save", "rename", "confirm", "done", "ok"].includes(norm(el.textContent)),
  );
  if (!confirm) return { state: "no-confirm" };
  confirm.click();
  await sleep(700);
  return {
    state: threadLinks().some((a) => norm(a.textContent) === norm(name))
      ? "renamed"
      : "unverified",
  };
})`;
