import type { DocsPath } from "@/lib/docs-paths.generated";

export type { DocsPath };

export const DOCS_BASE_URL = "https://docs.heypinchy.com";

export function docsUrl(path: DocsPath, hash?: string): string {
  const base = `${DOCS_BASE_URL}/${path}/`;
  return hash ? `${base}#${hash}` : base;
}

interface DocsLinkProps {
  path: DocsPath;
  hash?: string;
  children: React.ReactNode;
  className?: string;
}

export function DocsLink({ path, hash, children, className }: DocsLinkProps) {
  return (
    <a href={docsUrl(path, hash)} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}
