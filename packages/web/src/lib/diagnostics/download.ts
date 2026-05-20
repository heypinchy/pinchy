export function downloadBundle(bundle: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function buildBundleFilename(agentName: string, generatedAt: Date): string {
  const slug = agentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const stamp = generatedAt.toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "-");
  return `pinchy-bugreport-${slug}-${stamp}.json`;
}
