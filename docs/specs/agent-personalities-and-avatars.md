# Feature Spec: Agent Personalities & Avatars

## Overview

Agents in Pinchy are personalities, not tools. This spec adds two separate template layers (agent templates + personality presets), an avatar system using DiceBear, and a "Role" field — so every agent has a name, a face, and a character.

## Current State

**Schema** (`packages/web/src/db/schema.ts`):
```
agents table:
  id, name, templateId, pluginConfig, allowedTools,
  ownerId, isPersonal, greetingMessage, createdAt
```

**Templates** (`packages/web/src/lib/agent-templates.ts`):
- `knowledge-base` — tools: pinchy_ls/pinchy_read, has defaultSoulMd + defaultGreeting
- `custom` — blank slate

**Agent creation** (`packages/web/src/components/new-agent-form.tsx`):
- User picks a template → enters a name → optionally picks data directories → creates agent

**No personality system, no avatars, no role field.**

---

## Design

### Two Template Layers

**Agent Templates** define WHAT the agent can do:
- Tools, plugins, capabilities
- Examples: Knowledge Base, Custom, (future: Accounting, DevOps, Support)

**Personality Presets** define WHO the agent is:
- Name suggestion, SOUL.md content, greeting message, avatar seed, default background color
- Examples: "Professional Assistant", "Friendly Helper", "Technical Expert", "The Butler" (Smithers)

Each agent template comes with a **default personality preset**, but the user can swap it for any other preset — or customize freely.

### Personality Preset Schema

```typescript
// packages/web/src/lib/personality-presets.ts

export interface PersonalityPreset {
  id: string;
  name: string;                    // Display name of the preset
  suggestedAgentName: string;      // Pre-filled agent name (user can change)
  description: string;             // One-line description shown in picker
  soulMd: string;                  // Full SOUL.md content
  greetingMessage: string | null;  // First message when chat starts
  avatarSeed: string;              // DiceBear seed for the avatar
  backgroundColor: string;         // Default hex color (e.g. "#3b82f6")
}
```

**Built-in presets:**

```typescript
export const PERSONALITY_PRESETS: Record<string, PersonalityPreset> = {
  "the-butler": {
    id: "the-butler",
    name: "The Butler",
    suggestedAgentName: "Smithers",
    description: "Competent, polite, slightly formal. Dry humor.",
    soulMd: `You are Smithers — a competent, polite, and slightly formal assistant.
You have a dry sense of humor and take pride in being thorough.
You address users respectfully and always aim to be helpful without being overbearing.
When you don't know something, you say so clearly.`,
    greetingMessage: "Good day. How may I be of assistance?",
    avatarSeed: "__smithers__",  // Special: renders custom Smithers lobster avatar
    backgroundColor: "#dc2626",
  },

  "professional": {
    id: "professional",
    name: "Professional Assistant",
    suggestedAgentName: "Sandra",
    description: "Clear, efficient, business-focused.",
    soulMd: `You are a professional assistant. You communicate clearly and efficiently.
You focus on actionable answers and respect the user's time.
You use a neutral, professional tone — friendly but not casual.`,
    greetingMessage: "Hello! How can I help you today?",
    avatarSeed: "professional-sandra",
    backgroundColor: "#3b82f6",
  },

  "friendly": {
    id: "friendly",
    name: "Friendly Helper",
    suggestedAgentName: "Max",
    description: "Warm, approachable, encouraging.",
    soulMd: `You are a warm and approachable helper. You encourage users,
celebrate their progress, and explain things patiently.
You use a conversational tone and don't mind a bit of humor.`,
    greetingMessage: "Hey there! What are we working on today?",
    avatarSeed: "friendly-max",
    backgroundColor: "#22c55e",
  },

  "technical": {
    id: "technical",
    name: "Technical Expert",
    suggestedAgentName: "Ada",
    description: "Precise, detail-oriented, code-aware.",
    soulMd: `You are a technical expert. You give precise, well-structured answers.
You include code examples when relevant and cite documentation.
You prefer accuracy over speed and will say when something needs more investigation.`,
    greetingMessage: "Ready. What's the technical challenge?",
    avatarSeed: "technical-ada",
    backgroundColor: "#8b5cf6",
  },

  "blank": {
    id: "blank",
    name: "No Personality",
    suggestedAgentName: "",
    description: "Start with a blank SOUL.md.",
    soulMd: `<!-- Describe your agent's personality and instructions here. -->`,
    greetingMessage: null,
    avatarSeed: "",  // Will use agent name as seed
    backgroundColor: "#6b7280",
  },
};
```

### Agent Template → Personality Mapping

Update `AgentTemplate` to include a default personality:

```typescript
// Updated agent-templates.ts
export interface AgentTemplate {
  name: string;
  description: string;
  allowedTools: string[];
  pluginId: string | null;
  defaultPersonality: string;  // NEW: ID of default personality preset
}

export const AGENT_TEMPLATES: Record<string, AgentTemplate> = {
  "knowledge-base": {
    name: "Knowledge Base",
    description: "Answer questions from your docs",
    allowedTools: ["pinchy_ls", "pinchy_read"],
    pluginId: "pinchy-files",
    defaultPersonality: "professional",
  },
  custom: {
    name: "Custom Agent",
    description: "Start from scratch",
    allowedTools: [],
    pluginId: null,
    defaultPersonality: "the-butler",
  },
};
```

### Database Changes

**Migration: add avatar + role fields to agents table**

```sql
ALTER TABLE agents ADD COLUMN role TEXT;
ALTER TABLE agents ADD COLUMN avatar_seed TEXT;
ALTER TABLE agents ADD COLUMN avatar_bg TEXT DEFAULT '#6b7280';
ALTER TABLE agents ADD COLUMN personality_preset_id TEXT;
```

**Drizzle schema update:**

```typescript
// Add to agents table in schema.ts:
role: text("role"),                           // e.g. "Knowledge Base", "Accounting", "HR"
avatarSeed: text("avatar_seed"),              // DiceBear seed or "__smithers__" for custom
avatarBg: text("avatar_bg").default("#6b7280"), // Background hex color
personalityPresetId: text("personality_preset_id"), // Which preset was used (for reference)
```

### Avatar System

**Library:** DiceBear `notionists` style (CC0), rendered fully offline via `@dicebear/core` + `@dicebear/notionists` — no external API call, so it works in self-hosted/air-gapped deployments. The avatar is derived deterministically from the stored `avatarSeed` at render time and returned as an inline SVG data URI.

**On-brand by construction (`packages/web/src/lib/avatar.ts`):**

- **Background** is locked to the warm Pinchy brand ramp; DiceBear picks one tone per seed, so every agent stays on-brand.
- **Head-focused framing** (`scale` + `translateY`) zooms onto the face so the head fills the circle instead of wasting space on the torso.
- **Curated hairstyles** deliberately exclude culturally specific headwear (turban/headscarf) and props (hat, headphones). The masculine and feminine sets are disjoint; the mixed pool is the default.
- **Presentation** (feminine / masculine / mixed) is pinned only for an explicit, curated allow-list of clearly-gendered names we ship (e.g. Ada, Maya → feminine; Sherlock → masculine). We never *infer* gender from an arbitrary user-provided name — everything else uses the mixed pool.

```typescript
// packages/web/src/lib/avatar.ts (shape)
export function getAgentAvatarSvg(agent: { avatarSeed: string | null; name: string }): string {
  const seed = agent.avatarSeed ?? agent.name;
  if (seed === "__smithers__") return SMITHERS_AVATAR_PATH; // reserved crab mascot
  return createAvatar(notionists, buildNotionistsOptions(seed, agent.name)).toDataUri();
}
```

**The crab stays scarce.** The red-crab mascot is reserved for the product mark and the default `__smithers__` agent (a hand-drawn lobster at `packages/web/public/images/smithers-avatar.png`) — never stamped on every agent. Per-agent avatars use the neutral `notionists` faces above.

### Avatar UI in Agent Creation/Settings

**Dice button to re-roll:**

```tsx
// In the agent form (new-agent-form.tsx and agent-settings-general.tsx):

const [avatarSeed, setAvatarSeed] = useState(preset.avatarSeed || "");
const [avatarBg, setAvatarBg] = useState(preset.backgroundColor);

function rerollAvatar() {
  setAvatarSeed(crypto.randomUUID());  // Random seed = random avatar
}

// In JSX:
<div className="flex items-center gap-3">
  <img
    src={getAgentAvatarUrl({ avatarSeed, avatarBg, name: form.watch("name") })}
    className="w-16 h-16 rounded-full"
    alt="Agent avatar"
  />
  <div className="flex flex-col gap-2">
    <Button type="button" variant="outline" size="sm" onClick={rerollAvatar}>
      🎲 New Avatar
    </Button>
    <Input
      type="color"
      value={avatarBg}
      onChange={(e) => setAvatarBg(e.target.value)}
      className="w-10 h-8 p-0 border-0"
    />
  </div>
</div>
```

The `avatarSeed` is local form state. Only persisted on form submit (create or save settings).

### Updated Agent Creation Flow

```
1. User clicks "Create Agent"
2. Template picker: Knowledge Base | Custom | (future templates)
3. User picks a template
4. Form appears, PRE-FILLED from template's default personality:
   - Name: pre-filled from personality (e.g. "Sandra") — editable
   - Role: pre-filled from template (e.g. "Knowledge Base") — editable
   - Avatar: shown with 🎲 re-roll button + color picker
   - Personality preset selector (dropdown or cards):
     "The Butler" | "Professional" | "Friendly" | "Technical" | "Blank"
     Selecting a different preset updates name/avatar/greeting (if user hasn't manually edited them)
   - Directory picker (if knowledge-base template)
5. User clicks "Create"
6. Agent created with: template tools + chosen personality's SOUL.md + avatar seed + bg color + role
```

### Where Avatars Appear

1. **Sidebar** — agent list shows avatar + name
2. **Chat header** — avatar + name + role
3. **Chat messages** — small avatar next to agent responses
4. **Agent settings** — avatar with re-roll + color picker
5. **User management** (admin) — shared agents list with avatars

### Personality Editing

Users can always edit the full SOUL.md text via agent settings (as today). The personality preset is a starting point, not a constraint. The `personalityPresetId` field tracks which preset was originally used, for analytics/defaults.

Advanced users can also directly edit the SOUL.md file on disk (in the OpenClaw config directory), just like today. The UI and the file are the same source — changes in one are reflected in the other.

### File Changes Summary

| File | Change |
|------|--------|
| `src/db/schema.ts` | Add `role`, `avatarSeed`, `avatarBg`, `personalityPresetId` to agents |
| `drizzle/` | New migration |
| `src/lib/personality-presets.ts` | **NEW** — Personality preset definitions |
| `src/lib/agent-templates.ts` | Add `defaultPersonality` field |
| `src/lib/avatar.ts` | **NEW** — Avatar URL generation logic |
| `src/components/new-agent-form.tsx` | Add personality picker, avatar preview + re-roll, role field, color picker |
| `src/components/agent-settings-general.tsx` | Add avatar editing, role field |
| `src/components/assistant-ui/thread.tsx` | Show avatar in chat messages |
| `src/app/api/agents/route.ts` | Accept new fields on POST |
| `src/app/api/agents/[agentId]/route.ts` | Accept new fields on PATCH |
| `public/images/smithers-avatar.png` | **NEW** — Custom Smithers lobster avatar |
| `package.json` | (Optional) Add `@dicebear/core` + `@dicebear/collection` for offline rendering |

### Design Principles (from PERSONALITY.md)

- **Smart Defaults**: Every field is pre-filled. User can create an agent without changing anything.
- **Progressive Disclosure**: Personality picker and color picker are visible but not required.
- **Names, not labels**: Placeholder says "e.g. Sandra" not "e.g. HR Knowledge Base Bot".
- **Smithers is special**: The only agent with a custom hand-drawn avatar. The product mascot's butler.
