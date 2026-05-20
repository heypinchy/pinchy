export type JsonlEvent = Record<string, unknown>;

export function parseJsonlLines(input: string): JsonlEvent[] {
  return input
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as JsonlEvent];
      } catch {
        return [];
      }
    });
}
