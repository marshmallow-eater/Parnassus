import { expect, test, type Page } from "@playwright/test";

// Every test runs against the renderer served by vite, in a plain browser.
// There is no Electron preload in this environment, so the renderer uses
// the in-memory mock bridge: all file operations are simulated, and no test
// touches the real filesystem. The mock is reset by reloading the page,
// which each test gets fresh.

async function addProject(page: Page): Promise<void> {
  await page.getByTestId("add-project").click();
  await expect(page.locator("#scan-dialog")).toBeVisible();
  await page.getByTestId("copy-in").click();
  await expect(page.locator("#scan-dialog")).toBeHidden();
  await expect(page.getByTestId("project-row")).toHaveCount(1);
}

// Simulates a Muse-side edit through the mock bridge (the side pane no
// longer carries a per-file simulate button), then reopens the project
// so the pane re-runs its three-way check.
async function simulateMuseEdit(page: Page, path: string): Promise<void> {
  const projectId = await page
    .getByTestId("project-row")
    .first()
    .getAttribute("data-project-id");
  await page.evaluate(
    ([id, p]) => {
      const win = window as unknown as {
        __mockBridge: {
          stageEdit: (projectId: string, path: string) => Promise<unknown>;
        };
      };
      return win.__mockBridge.stageEdit(id!, p);
    },
    [projectId, path] as const,
  );
  await page.getByTestId("project-row").first().click();
}

async function editMockLocal(page: Page, path: string, content: string): Promise<void> {
  await page.evaluate(
    ([p, c]) => {
      const win = window as unknown as {
        __mockBridge: { editLocal: (path: string, content: string) => void };
      };
      win.__mockBridge.editLocal(p, c);
    },
    [path, content] as const,
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
});

test("project list renders and the generic chat is the default context", async ({ page }) => {
  await expect(page.getByTestId("context-label")).toHaveText("General");
  await expect(page.locator("#projects-empty")).toBeVisible();
  await expect(page.getByTestId("project-list")).toHaveCount(0);
  await expect(page.getByTestId("general-row")).toBeVisible();
});

test("hiding the projects pane gives the chat the full width and restores it", async ({
  page,
}) => {
  await expect(page.getByTestId("add-project")).toBeVisible();
  await page.getByTestId("toggle-projects").click();
  await expect(page.getByTestId("add-project")).toHaveCount(0);
  await page.getByTestId("toggle-projects").click();
  await expect(page.getByTestId("add-project")).toBeVisible();
});

test("the copy-in action stays reachable at a short viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.getByTestId("add-project").click();
  await expect(page.locator("#scan-dialog")).toBeVisible();
  const dialog = await page.locator("#scan-dialog").boundingBox();
  const button = await page.getByTestId("copy-in").boundingBox();
  expect(dialog).not.toBeNull();
  expect(button).not.toBeNull();
  if (dialog && button) {
    expect(button.y).toBeGreaterThanOrEqual(dialog.y);
    expect(button.y + button.height).toBeLessThanOrEqual(dialog.y + dialog.height);
    expect(button.y + button.height).toBeLessThanOrEqual(700);
  }
  await page.getByTestId("copy-in").click();
  await expect(page.locator("#scan-dialog")).toBeHidden();
});

test("each project keeps its own chat, separate from General", async ({ page }) => {
  const generalChat = page.locator('[data-testid="chat-surface"][data-owner="general"]');
  await expect(generalChat).toBeVisible();
  await expect(page.getByTestId("chat-surface")).toHaveCount(1);

  await addProject(page);
  const projectChat = page.locator('[data-testid="chat-surface"]:not([data-owner="general"])');
  await expect(projectChat).toBeVisible();
  await expect(generalChat).toBeHidden();
  // The general chat is kept alive, not destroyed.
  await expect(page.getByTestId("chat-surface")).toHaveCount(2);

  await page.getByTestId("general-row").click();
  await expect(generalChat).toBeVisible();
  await expect(projectChat).toBeHidden();
  await expect(page.getByTestId("chat-surface")).toHaveCount(2);

  await page.getByTestId("project-row").click();
  await expect(projectChat).toBeVisible();
  await expect(generalChat).toBeHidden();
});

test("the project chat is isolated and points at the project's folders", async ({ page }) => {
  await addProject(page);

  const generalChat = page.locator('[data-testid="chat-surface"][data-owner="general"]');
  const projectChat = page.locator('[data-testid="chat-surface"]:not([data-owner="general"])');
  // A different session partition per chat: no state leaks between them.
  const generalPartition = await generalChat.getAttribute("data-partition");
  const projectPartition = await projectChat.getAttribute("data-partition");
  expect(generalPartition).toBe("persist:muse");
  expect(projectPartition).toContain("persist:muse-");
  expect(projectPartition).not.toBe(generalPartition);
  await expect(projectChat).not.toHaveAttribute("data-work-folder", "");
  // A project with no thread of its own opens Muse's new-thread route,
  // never the main chat where the previously selected conversation sits.
  await expect(projectChat).toHaveAttribute("data-chat-url", "https://muse.ai/thread/new");
  await expect(generalChat).toHaveAttribute("data-chat-url", "https://muse.ai/");

  // The chat carries the project name as its thread name.
  await expect(projectChat).toHaveAttribute("data-thread-name", "field-notes");

  // The side pane shows just the project and its files with sync state.
  await expect(page.getByTestId("file-tree")).toBeVisible();
  await expect(page.getByTestId("sync-summary")).toContainText("synced");
  await expect(
    page.locator('[data-testid="tree-file"][data-path="notes.txt"]'),
  ).toBeVisible();
  // The text-heavy goal/soul/decisions panels are gone from the pane.
  await expect(page.getByTestId("project-profile")).toHaveCount(0);
  await expect(page.getByTestId("project-knowledge")).toHaveCount(0);
});

test("switching chat by its tab also selects the project", async ({ page }) => {
  await addProject(page);
  await expect(page.getByTestId("file-tree")).toBeVisible();

  await page.locator('[data-testid="chat-tab"][data-owner="general"]').click();
  await expect(page.getByTestId("file-tree")).toHaveCount(0);
  await expect(page.getByTestId("context-label")).toHaveText("General");

  const projectTab = page.locator('[data-testid="chat-tab"]:not([data-owner="general"])');
  await projectTab.click();
  await expect(page.getByTestId("file-tree")).toBeVisible();
  await expect(page.getByTestId("context-label")).not.toHaveText("General");
});

test("adding a project shows classification and skipped files with reasons", async ({ page }) => {
  await page.getByTestId("add-project").click();
  await expect(page.locator("#scan-dialog")).toBeVisible();

  const files = page.getByTestId("scan-files");
  await expect(files.locator("li", { hasText: "README.md" })).toBeVisible();
  await expect(files.locator("li", { hasText: "photo.png" })).toContainText("Readable binary");
  await expect(files.locator("li", { hasText: "report.pdf" })).toBeVisible();

  const skipped = page.getByTestId("skipped-list");
  await expect(skipped.locator("li", { hasText: "payload.bin" })).toContainText("Binary file");
  await expect(skipped.locator("li", { hasText: "node_modules" })).toContainText("Junk");
  await expect(skipped.locator("li", { hasText: "huge-dump.txt" })).toContainText(
    "Over the 5 MB limit",
  );
  await expect(skipped.locator("li", { hasText: "debug.log" })).toContainText(
    "Matched by .gitignore",
  );

  const deep = page.getByTestId("deep-list");
  await expect(deep.locator("li", { hasText: "src/" })).toContainText("2 files, not copied yet");
});

test("unticking a file keeps it out of the copy", async ({ page }) => {
  await page.getByTestId("add-project").click();
  await expect(page.locator("#scan-dialog")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "notes.txt" })).toBeChecked();
  await page.getByRole("checkbox", { name: "notes.txt" }).uncheck();
  await page.getByTestId("copy-in").click();
  await expect(page.locator("#scan-dialog")).toBeHidden();

  await expect(page.locator('[data-testid="tree-file"][data-path="README.md"]')).toBeVisible();
  await expect(page.locator('[data-testid="tree-file"][data-path="notes.txt"]')).toHaveCount(0);
});

test("overriding a skipped file includes it in the copy", async ({ page }) => {
  await page.getByTestId("add-project").click();
  await expect(page.locator("#scan-dialog")).toBeVisible();
  await page.getByRole("checkbox", { name: "payload.bin" }).check();
  await page.getByTestId("copy-in").click();
  await expect(page.locator("#scan-dialog")).toBeHidden();

  await expect(page.locator('[data-testid="tree-file"][data-path="payload.bin"]')).toBeVisible();
  await expect(page.getByTestId("project-state")).toHaveText("In sync");
});

test("include-all toggle for a skip reason checks the whole group", async ({ page }) => {
  await page.getByTestId("add-project").click();
  await expect(page.locator("#scan-dialog")).toBeVisible();
  await page.getByTestId("include-all-junk").click();
  const skipped = page.getByTestId("skipped-list");
  await expect(skipped.getByRole("checkbox", { name: "node_modules" })).toBeChecked();
  await expect(skipped.getByRole("checkbox", { name: ".git", exact: true })).toBeChecked();
});

test("opening a project after a local change shows local changed", async ({ page }) => {
  await addProject(page);
  await expect(page.getByTestId("project-state")).toHaveText("In sync");

  await editMockLocal(page, "notes.txt", "Changed on disk outside the app.\n");
  await page.getByTestId("project-row").click();

  await expect(page.getByTestId("project-state")).toHaveText("Local changed");
  await expect(
    page.locator('[data-testid="file-state"][data-path="notes.txt"]'),
  ).toHaveText("Local changed");
});

test("a staged edit goes through the sync approval and returns to in-sync", async ({
  page,
}) => {
  await addProject(page);

  await simulateMuseEdit(page, "notes.txt");
  await expect(page.getByTestId("project-state")).toHaveText("Muse changed");

  await page.getByTestId("open-sync").click();
  const dialog = page.locator("#sync-dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.locator('[data-testid="sync-file"][data-path="notes.txt"]'),
  ).toBeVisible();
  await expect(dialog).toContainText("Line added while working on the Muse side.");

  await page.getByTestId("approve-sync").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("project-state")).toHaveText("In sync");
  await expect(page.getByTestId("status-line")).toContainText("Muse → my files: notes.txt");
});

test("a local change can be sent to Muse from the same review", async ({ page }) => {
  await addProject(page);
  await editMockLocal(page, "notes.txt", "Changed on disk outside the app.\n");
  await page.getByTestId("project-row").click();
  await expect(page.getByTestId("project-state")).toHaveText("Local changed");

  await page.getByTestId("open-sync").click();
  const dialog = page.locator("#sync-dialog");
  await expect(dialog).toBeVisible();
  // The only sensible direction is preselected for a one-sided change.
  await expect(
    dialog.locator('[data-testid="sync-direction"][data-path="notes.txt"] input[value="to-muse"]'),
  ).toBeChecked();
  await page.getByTestId("approve-sync").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("project-state")).toHaveText("In sync");
  await expect(page.getByTestId("status-line")).toContainText("My files → Muse: notes.txt");
});

test("the file tree shows folders and each file's sync state", async ({ page }) => {
  // Copy in the deep src/ folder too, so the tree has a folder to show.
  await page.getByTestId("add-project").click();
  await expect(page.locator("#scan-dialog")).toBeVisible();
  await page.getByRole("checkbox", { name: "src" }).check();
  await page.getByTestId("copy-in").click();
  await expect(page.locator("#scan-dialog")).toBeHidden();

  const tree = page.getByTestId("file-tree");
  await expect(tree).toBeVisible();
  await expect(page.locator('[data-testid="tree-folder"][data-path="src"]')).toBeVisible();
  await expect(page.locator('[data-testid="tree-file"][data-path="src/main.ts"]')).toBeVisible();
  await expect(page.locator('[data-testid="tree-file"][data-path="notes.txt"]')).toBeVisible();
  await expect(page.getByTestId("sync-summary")).toContainText("synced");
  await expect(
    page.locator('[data-testid="file-state"][data-path="src/main.ts"]'),
  ).toHaveText("In sync");

  // A local change flips just that file (and its folder) in the tree.
  await editMockLocal(page, "src/main.ts", "Changed locally.\n");
  await page.getByTestId("project-row").click();
  await expect(
    page.locator('[data-testid="file-state"][data-path="src/main.ts"]'),
  ).toHaveText("Local changed");
  await expect(
    page.locator('[data-testid="folder-state"][data-path="src"]'),
  ).toHaveText("Local changed");
  await expect(page.getByTestId("sync-summary")).toContainText("not synced");

  // Full file content is sent only on demand, from the tree.
  await page.locator('[data-testid="send-file"][data-path="notes.txt"]').click();
  await expect(page.getByTestId("status-line")).toContainText("desktop app");

  // The file-request loop (agent asks for a file, it is sent in) is on
  // by default and can be turned off.
  const loopToggle = page.getByTestId("file-loop-toggle");
  await expect(loopToggle).toContainText("File loop: on");
  await loopToggle.click();
  await expect(loopToggle).toContainText("File loop: off");
  await loopToggle.click();
  await expect(loopToggle).toContainText("File loop: on");
});

test("a both-sides change conflicts and blocks applying until a direction is picked", async ({
  page,
}) => {
  await addProject(page);

  await editMockLocal(page, "notes.txt", "Local rewrite of the note.\n");
  await simulateMuseEdit(page, "notes.txt");
  await expect(page.getByTestId("project-state")).toHaveText("Conflict");

  await page.getByTestId("open-sync").click();
  const dialog = page.locator("#sync-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("sync-blocked")).toBeVisible();
  await expect(page.getByTestId("approve-sync")).toBeDisabled();

  await page
    .locator('[data-testid="sync-direction"][data-path="notes.txt"] input[value="to-local"]')
    .check();
  await expect(page.getByTestId("approve-sync")).toBeEnabled();

  await page.getByTestId("approve-sync").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("project-state")).toHaveText("In sync");
});

test("sending a conflict to Muse clears the conflict", async ({ page }) => {
  await addProject(page);

  await editMockLocal(page, "notes.txt", "Another local rewrite.\n");
  await simulateMuseEdit(page, "notes.txt");
  await expect(page.getByTestId("project-state")).toHaveText("Conflict");

  await page.getByTestId("open-sync").click();
  await page
    .locator('[data-testid="sync-direction"][data-path="notes.txt"] input[value="to-muse"]')
    .check();
  await page.getByTestId("approve-sync").click();

  await expect(page.locator("#sync-dialog")).toBeHidden();
  await expect(page.getByTestId("project-state")).toHaveText("In sync");
  await expect(page.getByTestId("status-line")).toContainText("My files → Muse: notes.txt");
});
