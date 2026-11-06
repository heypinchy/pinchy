/**
 * The citation viewer's url: `/api/agents/:agentId/workspace-file/<name>?path=…`.
 *
 * The SAME handler as the bare route — same containment, same audit, same
 * headers — reached through a url whose last path segment is the document's
 * name. A browser's built-in PDF viewer titles a document after that segment
 * whenever the file carries no title of its own, so without it the toolbar
 * above a cited document said "workspace-file" (#1268). The handler refuses a
 * name that is not the name of the bytes it serves.
 *
 * Embeddable, so it needs its own SAMEORIGIN entry in next.config.ts — the
 * handler's header loses to the global DENY (see AGENTS.md § "Embeddable
 * Serving Routes Need A next.config Entry").
 */
export { GET } from "../route";
