// Routing for the General orchestrator: which project, if any, a question
// belongs to. Pure keyword scoring over what the user allowed it to use —
// the project name, its goal and soul, its decisions and memory, and the
// names of its copied-in files. No clear winner means the question stays
// in General; the orchestrator never guesses between close matches.

export interface RoutingCandidate {
  projectId: string;
  name: string;
  goal: string;
  soul: string;
  decisions: string | null;
  memory: string | null;
  fileNames: string[];
}

export interface RouteScore {
  projectId: string;
  score: number;
  reasons: string[];
}

export interface RouteResult {
  ranked: RouteScore[];
  best: RouteScore | null;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with",
  "is", "are", "was", "were", "be", "been", "it", "its", "this", "that",
  "what", "when", "where", "which", "who", "how", "why", "should", "would",
  "could", "do", "does", "did", "i", "we", "you", "my", "our", "your",
  "me", "us", "if", "so", "at", "by", "from", "about", "into", "there",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

const MIN_SCORE = 3;

function scoreCandidate(question: string, tokens: Set<string>, candidate: RoutingCandidate): RouteScore {
  let score = 0;
  const reasons = new Set<string>();
  const hit = (weight: number, reason: string): void => {
    score += weight;
    reasons.add(reason);
  };
  // Naming the project is the strongest signal there is.
  const nameTokens = tokenize(candidate.name.replace(/[-_]/g, " "));
  if (
    candidate.name.length >= 3 &&
    (question.toLowerCase().includes(candidate.name.toLowerCase()) ||
      nameTokens.some((token) => tokens.has(token)))
  ) {
    hit(6, `names the project (${candidate.name})`);
  }
  const fields: [string | null, number, string][] = [
    [candidate.goal, 3, "matches its goal"],
    [candidate.memory, 2, "matches its memory.md"],
    [candidate.decisions, 2, "matches its decisions.md"],
    [candidate.soul, 1, "matches its soul"],
  ];
  for (const [text, weight, reason] of fields) {
    if (!text) continue;
    for (const token of new Set(tokenize(text))) {
      if (tokens.has(token)) hit(weight, reason);
    }
  }
  for (const fileName of candidate.fileNames) {
    if (question.toLowerCase().includes(fileName.toLowerCase())) {
      hit(4, `names its file ${fileName}`);
      continue;
    }
    for (const token of new Set(tokenize(fileName))) {
      if (tokens.has(token)) hit(2, `mentions ${fileName}`);
    }
  }
  return { projectId: candidate.projectId, score, reasons: [...reasons] };
}

export function routeQuestion(question: string, candidates: RoutingCandidate[]): RouteResult {
  const tokens = new Set(tokenize(question));
  if (tokens.size === 0 || candidates.length === 0) return { ranked: [], best: null };
  const ranked = candidates
    .map((candidate) => scoreCandidate(question, tokens, candidate))
    .sort((a, b) => b.score - a.score);
  const [top, second] = ranked;
  const best =
    top !== undefined && top.score >= MIN_SCORE && (second === undefined || top.score > second.score)
      ? top
      : null;
  return { ranked, best };
}
