"use client";

import { useMemo, useState, type KeyboardEvent } from "react";
import { X, Plus, Minus, Info, AlertTriangle, ChevronDown } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { AgentPluginConfig } from "@/db/schema";
import { isValidDomain } from "@/lib/domain-validation";
import { getCountryOptions, getLanguageOptions } from "@/lib/locale-options";

type WebSearchConfig = NonNullable<AgentPluginConfig["pinchy-web"]>;
type Mode = "include" | "exclude";

interface WebSearchPermissionSectionProps {
  config: WebSearchConfig;
  onChange: (config: WebSearchConfig) => void;
  showSecurityWarning: boolean;
  hasApiKey: boolean;
}

const FRESHNESS_OPTIONS = [
  { value: "", label: "Any time" },
  { value: "pd", label: "Last day" },
  { value: "pw", label: "Last week" },
  { value: "pm", label: "Last month" },
  { value: "py", label: "Last year" },
];

const EMPTY_SENTINEL = "__any__";

function toSelectValue(v: string | undefined): string {
  return v || EMPTY_SENTINEL;
}

function fromSelectValue(v: string): string {
  return v === EMPTY_SENTINEL ? "" : v;
}

function ModeSelector({ value, onChange }: { value: Mode; onChange: (mode: Mode) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Restriction type"
      className="inline-flex h-9 rounded-md border border-input bg-background p-0.5 text-sm"
    >
      {(["include", "exclude"] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          onClick={() => onChange(m)}
          className={cn(
            "flex items-center rounded-sm px-3 capitalize transition-colors",
            value === m
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

function DomainChip({
  domain,
  mode,
  onToggle,
  onRemove,
}: {
  domain: string;
  mode: Mode;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const otherMode: Mode = mode === "include" ? "exclude" : "include";
  const otherModeLabel = otherMode === "include" ? "Include" : "Exclude";
  const Icon = mode === "include" ? Plus : Minus;
  const chipClass =
    mode === "include"
      ? "bg-emerald-50 text-emerald-900 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-900"
      : "bg-rose-50 text-rose-900 border-rose-200 dark:bg-rose-950/40 dark:text-rose-200 dark:border-rose-900";
  const chipTitle =
    mode === "include"
      ? `Agent is allowed to access ${domain}`
      : `Agent is blocked from accessing ${domain}`;

  return (
    <span
      data-chip-mode={mode}
      title={chipTitle}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
        chipClass
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-label={`Toggle ${domain} to ${otherModeLabel}`}
        title={`Switch to ${otherModeLabel}`}
        className="flex size-4 items-center justify-center rounded-sm hover:bg-black/10 dark:hover:bg-white/10"
      >
        <Icon className="size-3" />
      </button>
      <span>{domain}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${domain}`}
        title={`Remove ${domain}`}
        className="flex size-4 items-center justify-center rounded-sm hover:bg-black/10 dark:hover:bg-white/10"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

export function WebSearchPermissionSection({
  config,
  onChange,
  showSecurityWarning,
  hasApiKey,
}: WebSearchPermissionSectionProps) {
  const allowedDomains = config.allowedDomains ?? [];
  const excludedDomains = config.excludedDomains ?? [];
  const hasRestrictions = allowedDomains.length + excludedDomains.length > 0;

  const [inputExpanded, setInputExpanded] = useState(hasRestrictions);
  const [mode, setMode] = useState<Mode>("include");
  const [inputValue, setInputValue] = useState("");

  const showInput = inputExpanded || hasRestrictions;
  const languageOptions = useMemo(() => getLanguageOptions(), []);
  const countryOptions = useMemo(() => getCountryOptions(), []);

  function addDomain(domain: string, targetMode: Mode) {
    if (allowedDomains.includes(domain) || excludedDomains.includes(domain)) return;
    if (targetMode === "include") {
      onChange({ ...config, allowedDomains: [...allowedDomains, domain] });
    } else {
      onChange({ ...config, excludedDomains: [...excludedDomains, domain] });
    }
  }

  function removeDomain(domain: string, fromMode: Mode) {
    if (fromMode === "include") {
      onChange({
        ...config,
        allowedDomains: allowedDomains.filter((d) => d !== domain),
      });
    } else {
      onChange({
        ...config,
        excludedDomains: excludedDomains.filter((d) => d !== domain),
      });
    }
  }

  function toggleDomainMode(domain: string, currentMode: Mode) {
    if (currentMode === "include") {
      onChange({
        ...config,
        allowedDomains: allowedDomains.filter((d) => d !== domain),
        excludedDomains: [...excludedDomains, domain],
      });
    } else {
      onChange({
        ...config,
        excludedDomains: excludedDomains.filter((d) => d !== domain),
        allowedDomains: [...allowedDomains, domain],
      });
    }
  }

  function commitInput() {
    const domain = inputValue.trim().toLowerCase();
    if (domain && isValidDomain(domain)) {
      addDomain(domain, mode);
    }
    setInputValue("");
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    commitInput();
  }

  return (
    <div className="space-y-4">
      {!hasApiKey && (
        <Alert className="border-blue-500/50 text-blue-700 dark:text-blue-400">
          <Info className="size-4" />
          <AlertTitle>API key required</AlertTitle>
          <AlertDescription>
            Web search requires a Brave Search API key. Configure one in Settings &rarr;
            Integrations.
          </AlertDescription>
        </Alert>
      )}

      {showSecurityWarning && (
        <Alert className="border-amber-500/50 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="size-4" />
          <AlertTitle>Data exfiltration risk</AlertTitle>
          <AlertDescription>
            This agent can access files/integrations and fetch external web pages. In rare cases,
            malicious web content could attempt to extract data through crafted URLs. Consider
            restricting web access to specific domains.
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <div className="space-y-0.5">
          <Label>Domain restrictions</Label>
          <p className="text-xs text-muted-foreground">Applies to both tools above.</p>
        </div>
        {!showInput ? (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed bg-muted/30 p-3 text-sm text-muted-foreground">
            <span>This agent can browse the entire web without restrictions.</span>
            <Button type="button" variant="secondary" onClick={() => setInputExpanded(true)}>
              Add restriction
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <ModeSelector value={mode} onChange={setMode} />
              <Input
                id="domain-input"
                aria-label="Add domain"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="example.com"
                className="max-w-xs"
              />
              <Button
                type="button"
                variant="secondary"
                onClick={commitInput}
                disabled={!inputValue.trim()}
              >
                Add
              </Button>
            </div>
            {hasRestrictions && (
              <div className="flex flex-wrap gap-1.5">
                {allowedDomains.map((d) => (
                  <DomainChip
                    key={`inc-${d}`}
                    domain={d}
                    mode="include"
                    onToggle={() => toggleDomainMode(d, "include")}
                    onRemove={() => removeDomain(d, "include")}
                  />
                ))}
                {excludedDomains.map((d) => (
                  <DomainChip
                    key={`exc-${d}`}
                    domain={d}
                    mode="exclude"
                    onToggle={() => toggleDomainMode(d, "exclude")}
                    onRemove={() => removeDomain(d, "exclude")}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 h-8 gap-1 text-muted-foreground [&[data-state=open]>svg]:rotate-180"
          >
            <ChevronDown className="size-4 transition-transform" />
            Advanced options
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="freshness-select">Freshness</Label>
              <Select
                value={toSelectValue(config.freshness)}
                onValueChange={(v) =>
                  onChange({ ...config, freshness: fromSelectValue(v) || undefined })
                }
              >
                <SelectTrigger id="freshness-select" aria-label="Freshness" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FRESHNESS_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value || "any"} value={opt.value || EMPTY_SENTINEL}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="language-select">Language</Label>
              <Combobox
                id="language-select"
                aria-label="Language"
                value={config.language}
                onChange={(v) => onChange({ ...config, language: v })}
                options={languageOptions}
                placeholder="Any"
                searchPlaceholder="Search language…"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="region-select">Region</Label>
              <Combobox
                id="region-select"
                aria-label="Region"
                value={config.country}
                onChange={(v) => onChange({ ...config, country: v })}
                options={countryOptions}
                placeholder="Any"
                searchPlaceholder="Search country…"
              />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
