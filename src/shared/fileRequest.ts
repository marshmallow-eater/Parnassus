// The file-request loop between a project's Muse chat and Parnassus.
//
// A project chat starts with the project description and file summaries,
// not file contents. When the agent needs a file in full, it replies
// with exactly this marker plus the file's project-relative path:
//
//   PARNASSUS_FILE_REQUEST: src/api.ts
//
// Parnassus watches the chat for the marker, sends that one staged
// file's full content as the next message, and the agent answers with
// the file in hand. It can request another file the same way, so
// retrieval is a loop of small steps instead of one huge prompt.

export const FILE_REQUEST_MARKER = "PARNASSUS_FILE_REQUEST:";

// The instruction line the context pack gives the agent for the loop.
export const FILE_REQUEST_INSTRUCTION =
  `If you need the full content of a file, reply with exactly one line "${FILE_REQUEST_MARKER} <path>" (the file's path as listed below) and nothing else. ` +
  "The full file will be sent into this chat; then answer the original question using it. " +
  "If you still need another file afterwards, request it the same way. Do not guess a file's content from its summary.";

export interface FileRequest {
  path: string;
  // 1-based count of requests seen up to and including this one, so the
  // same file requested again in a later round is a new request, while
  // re-reading the same chat text never re-sends the same one twice.
  occurrence: number;
}

// Only project-relative paths are requestable: no absolute paths, no
// escaping the project with "..", no URLs.
function requestablePath(raw: string): string | null {
  const path = raw.trim().replace(/^["'`]+|["'`.,;:]+$/g, "");
  if (path === "" || path.startsWith("/") || path.includes("://")) return null;
  if (path.split("/").some((segment) => segment === ".." || segment === "")) return null;
  return path;
}

export function parseFileRequests(text: string): string[] {
  return parseFileRequestList(text).map((request) => request.path);
}

export function parseFileRequestList(text: string): FileRequest[] {
  const requests: FileRequest[] = [];
  for (const line of text.split(/\r?\n/)) {
    // A request is a line of its own starting with the marker, exactly
    // as the agent is instructed to send it; mentioning the marker in
    // prose is not a request.
    const trimmed = line.trim();
    if (!trimmed.startsWith(FILE_REQUEST_MARKER)) continue;
    const path = requestablePath(trimmed.slice(FILE_REQUEST_MARKER.length));
    if (path && !/\s/.test(path)) {
      requests.push({ path, occurrence: requests.length + 1 });
    }
  }
  return requests;
}

export function latestFileRequest(text: string): FileRequest | null {
  const requests = parseFileRequestList(text);
  return requests.length > 0 ? requests[requests.length - 1]! : null;
}
