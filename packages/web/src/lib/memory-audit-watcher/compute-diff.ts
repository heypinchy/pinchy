export type LineDiff = { addedLines: number; removedLines: number };

function toLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function multisetCount(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

export function computeLineDiff(oldContent: string, newContent: string): LineDiff {
  const oldCounts = multisetCount(toLines(oldContent));
  const newCounts = multisetCount(toLines(newContent));

  let addedLines = 0;
  let removedLines = 0;

  for (const [line, count] of newCounts) {
    const oldCount = oldCounts.get(line) ?? 0;
    if (count > oldCount) addedLines += count - oldCount;
  }
  for (const [line, count] of oldCounts) {
    const newCount = newCounts.get(line) ?? 0;
    if (count > newCount) removedLines += count - newCount;
  }

  return { addedLines, removedLines };
}
