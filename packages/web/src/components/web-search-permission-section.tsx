"use client";

import { useState, type KeyboardEvent } from "react";
import { X, Info, AlertTriangle } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { AgentPluginConfig } from "@/db/schema";

type WebSearchConfig = NonNullable<AgentPluginConfig["pinchy-web"]>;

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

const LANGUAGE_OPTIONS = [
  { value: "", label: "Any" },
  { value: "en", label: "English" },
  { value: "de", label: "German" },
  { value: "fr", label: "French" },
  { value: "es", label: "Spanish" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "nl", label: "Dutch" },
  { value: "ja", label: "Japanese" },
  { value: "zh", label: "Chinese" },
];

const REGION_OPTIONS = [
  { value: "", label: "Any" },
  { value: "AT", label: "Austria" },
  { value: "DE", label: "Germany" },
  { value: "CH", label: "Switzerland" },
  { value: "US", label: "United States" },
  { value: "GB", label: "United Kingdom" },
  { value: "FR", label: "France" },
  { value: "ES", label: "Spain" },
  { value: "IT", label: "Italy" },
  { value: "JP", label: "Japan" },
];

// Radix Select uses "" as "no value" internally, so we map empty strings to a
// sentinel for the Select value prop and back again in onValueChange.
const EMPTY_SENTINEL = "__any__";

function toSelectValue(v: string | undefined): string {
  return v || EMPTY_SENTINEL;
}

function fromSelectValue(v: string): string {
  return v === EMPTY_SENTINEL ? "" : v;
}

function DomainTagInput({
  label,
  domains,
  onAdd,
  onRemove,
}: {
  label: string;
  domains: string[];
  onAdd: (domain: string) => void;
  onRemove: (domain: string) => void;
}) {
  const [inputValue, setInputValue] = useState("");

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      const domain = inputValue.trim().toLowerCase();
      if (domain && !domains.includes(domain)) {
        onAdd(domain);
      }
      setInputValue("");
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={`domain-input-${label}`}>{label}</Label>
      <Input
        id={`domain-input-${label}`}
        aria-label={label}
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a domain and press Enter"
        className="max-w-sm"
      />
      {domains.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {domains.map((domain) => (
            <Badge key={domain} variant="secondary" className="gap-1 pr-1">
              {domain}
              <button
                type="button"
                onClick={() => onRemove(domain)}
                className="ml-1 rounded-full hover:bg-muted-foreground/20 p-0.5"
                aria-label={`Remove ${domain}`}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
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

  function handleAddAllowedDomain(domain: string) {
    onChange({ ...config, allowedDomains: [...allowedDomains, domain] });
  }

  function handleRemoveAllowedDomain(domain: string) {
    onChange({
      ...config,
      allowedDomains: allowedDomains.filter((d) => d !== domain),
    });
  }

  function handleAddExcludedDomain(domain: string) {
    onChange({ ...config, excludedDomains: [...excludedDomains, domain] });
  }

  function handleRemoveExcludedDomain(domain: string) {
    onChange({
      ...config,
      excludedDomains: excludedDomains.filter((d) => d !== domain),
    });
  }

  function handleFreshnessChange(value: string) {
    const freshness = fromSelectValue(value);
    onChange({ ...config, freshness: freshness || undefined });
  }

  function handleLanguageChange(value: string) {
    const language = fromSelectValue(value);
    onChange({ ...config, language: language || undefined });
  }

  function handleRegionChange(value: string) {
    const country = fromSelectValue(value);
    onChange({ ...config, country: country || undefined });
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

      <DomainTagInput
        label="Allowed Domains"
        domains={allowedDomains}
        onAdd={handleAddAllowedDomain}
        onRemove={handleRemoveAllowedDomain}
      />

      <DomainTagInput
        label="Excluded Domains"
        domains={excludedDomains}
        onAdd={handleAddExcludedDomain}
        onRemove={handleRemoveExcludedDomain}
      />

      <div className="space-y-2">
        <Label htmlFor="freshness-select">Freshness</Label>
        <Select value={toSelectValue(config.freshness)} onValueChange={handleFreshnessChange}>
          <SelectTrigger id="freshness-select" aria-label="Freshness" className="max-w-sm">
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
        <Select value={toSelectValue(config.language)} onValueChange={handleLanguageChange}>
          <SelectTrigger id="language-select" aria-label="Language" className="max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value || "any"} value={opt.value || EMPTY_SENTINEL}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="region-select">Region</Label>
        <Select value={toSelectValue(config.country)} onValueChange={handleRegionChange}>
          <SelectTrigger id="region-select" aria-label="Region" className="max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REGION_OPTIONS.map((opt) => (
              <SelectItem key={opt.value || "any"} value={opt.value || EMPTY_SENTINEL}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
