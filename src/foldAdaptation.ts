import type { FoldingRange } from "vscode";
import type { BraceFold } from "./braceFolds";

export function mergeFoldRanges(
  brackets: ReadonlyMap<number, BraceFold>,
  supplemental: readonly FoldingRange[],
  lineCount: number,
): FoldingRange[] {
  const local = Array.from(brackets.values(), ({ startLine: start, endLine: end }) => ({ start, end }));
  local.sort((left, right) => left.start - right.start);
  const candidates = supplemental.filter(({ start, end }) => {
    const allman = brackets.get(start - 1);
    const isAllmanDuplicate = allman?.preview && allman.preview.openingColumn === undefined &&
      (end === allman.endLine || end === allman.endLine - 1);
    return start >= 0 && end < lineCount && start < end && !brackets.has(start) && !isAllmanDuplicate;
  });

  // A range crosses a bracket if just one of its endpoints lies inside it.
  const withinStart = withoutCrossings(local, candidates, "start");
  const withinEnd = withoutCrossings(local, withinStart, "end");
  const accepted = new Set(withinEnd);
  return [...local, ...supplemental.filter(range => accepted.has(range))].sort((left, right) => left.start - right.start);
}

function withoutCrossings(
  local: readonly FoldingRange[],
  candidates: FoldingRange[],
  endpoint: "start" | "end",
): FoldingRange[] {
  candidates.sort((left, right) => left[endpoint] - right[endpoint]);
  const open: FoldingRange[] = [];
  let next = 0;
  const getLastCoveredLine = (range: FoldingRange) => range.end - Number(endpoint === "end");
  return candidates.filter(candidate => {
    const line = candidate[endpoint];
    while (next < local.length && local[next].start <= line) {
      const bracket = local[next++];
      while (open.length && getLastCoveredLine(open[open.length - 1]) < bracket.start) {
        open.pop();
      }
      open.push(bracket);
    }
    while (open.length && getLastCoveredLine(open[open.length - 1]) < line) {
      open.pop();
    }
    const bracket = open.at(-1);
    return !bracket || (endpoint === "start" ? candidate.end <= bracket.end : candidate.start >= bracket.start);
  });
}
