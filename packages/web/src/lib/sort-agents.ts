// Plain module (no "use client", no db imports) so server components and
// client components order agents identically: personal first, then by name.
export function sortAgents<T extends { name: string; isPersonal: boolean }>(agents: T[]): T[] {
  return [...agents].sort((a, b) => {
    if (a.isPersonal && !b.isPersonal) return -1;
    if (!a.isPersonal && b.isPersonal) return 1;
    return a.name.localeCompare(b.name);
  });
}
