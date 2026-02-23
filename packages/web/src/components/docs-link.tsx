export const DOCS_BASE_URL = "https://docs.heypinchy.com";

interface DocsLinkProps {
  path: string;
  children: React.ReactNode;
  className?: string;
}

export function DocsLink({ path, children, className }: DocsLinkProps) {
  const href = `${DOCS_BASE_URL}/${path}/`;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {children}
    </a>
  );
}
