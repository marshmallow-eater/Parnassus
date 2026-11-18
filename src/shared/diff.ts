// A small line-based diff for the conflict view. LCS over lines; inputs in
// this app are note and source files, so the quadratic table is fine.

export type DiffLine =
  | { kind: "same"; text: string }
  | { kind: "local"; text: string }
  | { kind: "muse"; text: string };

export function diffLines(localText: string, museText: string): DiffLine[] {
  const a = localText.split("\n");
  const b = museText.split("\n");
  const rows = a.length + 1;
  const cols = b.length + 1;
  const lcs: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "local", text: a[i] });
      i++;
    } else {
      out.push({ kind: "muse", text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "local", text: a[i++] });
  while (j < b.length) out.push({ kind: "muse", text: b[j++] });
  return out;
}
