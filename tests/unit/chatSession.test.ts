import { describe, expect, test } from "bun:test";
import {
  bindableChatUrl,
  chatPartitionForOwner,
  GENERAL_CHAT_OWNER,
  initialChatUrl,
  MUSE_HOME_URL,
  museWorkFolder,
  RENAME_THREAD_SCRIPT,
  threadNameForProject,
} from "../../src/shared/chatSession";

describe("chatPartitionForOwner", () => {
  test("every project gets its own partition, distinct from General and other projects", () => {
    const general = chatPartitionForOwner(GENERAL_CHAT_OWNER);
    const a = chatPartitionForOwner("p-aaa");
    const b = chatPartitionForOwner("p-bbb");
    expect(general).toBe("persist:muse");
    expect(a).toBe("persist:muse-p-aaa");
    expect(b).toBe("persist:muse-p-bbb");
    expect(new Set([general, a, b]).size).toBe(3);
    expect(chatPartitionForOwner("p-aaa")).toBe(a);
  });
});

describe("bindableChatUrl", () => {
  test("accepts a conversation-specific muse.ai URL", () => {
    expect(bindableChatUrl("https://muse.ai/thread/abc-123")).toBe(
      "https://muse.ai/thread/abc-123",
    );
  });

  test("never binds the shared home/main chat, the new-thread draft, auth pages, or other hosts", () => {
    expect(bindableChatUrl("https://muse.ai")).toBeNull();
    expect(bindableChatUrl("https://muse.ai/")).toBeNull();
    expect(bindableChatUrl("https://muse.ai/thread/main")).toBeNull();
    // /thread/new only starts a fresh draft; binding it would reopen a draft, not a conversation.
    expect(bindableChatUrl("https://muse.ai/thread/new")).toBeNull();
    expect(bindableChatUrl("https://muse.ai/login")).toBeNull();
    expect(bindableChatUrl("https://example.com/thread/abc")).toBeNull();
    expect(bindableChatUrl(null)).toBeNull();
    expect(bindableChatUrl("not a url")).toBeNull();
  });
});

describe("initialChatUrl", () => {
  test("a project with no isolated chat starts a brand-new thread, not the old/main chat", () => {
    // Regression: this used to load https://muse.ai/ (the main chat), so a
    // project opened on whatever conversation was already selected there.
    expect(initialChatUrl(null)).toBe("https://muse.ai/thread/new");
    expect(initialChatUrl({ isolatedChatUrl: null })).toBe("https://muse.ai/thread/new");
    expect(initialChatUrl({ isolatedChatUrl: "https://muse.ai/" })).toBe(
      "https://muse.ai/thread/new",
    );
  });

  test("reopens the project's own isolated thread once one is bound", () => {
    expect(initialChatUrl({ isolatedChatUrl: "https://muse.ai/thread/abc" })).toBe(
      "https://muse.ai/thread/abc",
    );
  });

  test("a legacy chatUrl from before isolation is not trusted as the project's chat", () => {
    // Bindings written by the old build were whatever conversation happened
    // to be selected, so they must not be reopened as this project's chat.
    const legacy = { chatUrl: "https://muse.ai/thread/old-selected" } as {
      isolatedChatUrl?: string | null;
    };
    expect(initialChatUrl(legacy)).toBe("https://muse.ai/thread/new");
  });
});

describe("thread naming", () => {
  test("a project's chat is named exactly after the project", () => {
    expect(threadNameForProject({ name: "field-notes" })).toBe("field-notes");
    expect(threadNameForProject({ name: "  Field Notes  " })).toBe("Field Notes");
    expect(threadNameForProject({ name: "   " })).toBe("Project chat");
  });

  test("the rename script only drives Muse's rename dialog, never delete", () => {
    // It must open the thread options, pick the exact Rename item, type
    // into the dialog, and confirm inside that same dialog.
    expect(RENAME_THREAD_SCRIPT).toContain('"rename"');
    expect(RENAME_THREAD_SCRIPT).toContain('[role="dialog"]');
    expect(RENAME_THREAD_SCRIPT.toLowerCase()).not.toContain("delete");
    // Already-named threads are left alone.
    expect(RENAME_THREAD_SCRIPT).toContain("already");
  });

  test("the context pack tells the agent the chat's name", () => {
    // Covered in contextPack.test.ts too: the first message a project
    // chat gets names the conversation after the project.
    expect(threadNameForProject({ name: "algo" })).toBe("algo");
  });
});

describe("museWorkFolder", () => {
  test("is deterministic per project and different between projects", () => {
    const a = museWorkFolder({ id: "p-aaa", name: "Field Notes" });
    expect(a).toBe("parnassus/projects/field-notes-p-aaa");
    expect(museWorkFolder({ id: "p-aaa", name: "Field Notes" })).toBe(a);
    expect(museWorkFolder({ id: "p-bbb", name: "Field Notes" })).not.toBe(a);
    expect(museWorkFolder({ id: "p-aaa", name: "Other" })).not.toBe(a);
  });
});
