import type { ReactNode } from "react";
import { siAnthropic, siGoogle, siOllama } from "simple-icons";
import type { ProviderName } from "@/lib/providers";

type SimpleIcon = { title: string; path: string };

/** Render a simple-icons brand mark monochrome (inherits the tile's text color). */
function BrandGlyph({ icon }: { icon: SimpleIcon }) {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden="true" fill="currentColor">
      <path d={icon.path} />
    </svg>
  );
}

// Provider tile logos — real brand marks from simple-icons (MIT), rendered
// monochrome so they sit calmly in the tile and read as one set. OpenAI isn't in
// simple-icons (pulled on a trademark request), so it keeps a neutral monogram;
// drop an official OpenAI SVG into this map to complete the set. Ollama Cloud and
// Ollama Local share the Ollama mark — the tile label distinguishes them.
const PROVIDER_LOGO: Partial<Record<ProviderName, ReactNode>> = {
  anthropic: <BrandGlyph icon={siAnthropic} />,
  google: <BrandGlyph icon={siGoogle} />,
  "ollama-cloud": <BrandGlyph icon={siOllama} />,
  "ollama-local": <BrandGlyph icon={siOllama} />,
};

// Neutral monogram fallback for any provider without a wired logo (today: OpenAI).
const PROVIDER_FALLBACK: Record<ProviderName, ReactNode> = {
  anthropic: "A",
  openai: "O",
  google: "G",
  "ollama-cloud": "O",
  "ollama-local": "O",
};

/** The glyph shown inside a provider tile — its brand logo if we have one, else a monogram. */
export function ProviderLogo({ provider }: { provider: ProviderName }) {
  return <>{PROVIDER_LOGO[provider] ?? PROVIDER_FALLBACK[provider]}</>;
}
