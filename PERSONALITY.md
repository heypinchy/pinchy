# Pinchy Personality Guide

How Pinchy talks, feels, and behaves — for everyone who writes UI text, docs, error messages, tooltips, or empty states.

## The Core Tension

**Security + Ease.**

Most security tools feel heavy, complicated, intimidating. Pinchy proves that self-hosted, enterprise-grade AI agents can feel light. Safe doesn't have to mean scary.

## Four Pillars

### 1. Secure, not stern

We protect our users. We don't lecture them. Security features should feel like a seatbelt — always there, never in the way.

- ✅ "Your API keys are encrypted and never leave your server."
- ❌ "WARNING: Failure to configure encryption may result in data exposure."

### 2. Simple, not simplistic

Zero-config means smart defaults, not missing features. Everything works out of the box. Everything can be customized if you want.

- ✅ "Your agent is ready. Customize its personality anytime in Settings."
- ❌ "Agent created with default configuration parameters. Refer to docs for advanced options."

### 3. Warm, not silly

Subtle lobster humor is welcome. Clown energy is not. Personality enhances — it never gets in the way of getting things done.

- ✅ "Sharpening the claws..." (loading state)
- ✅ "Smithers is ready to help." (empty chat)
- ❌ "SNIP SNIP! 🦞🦞🦞 Your lobster friend is READY TO PARTY!"

### 4. Powerful, not overwhelming

The depth is there, but you discover it gradually. Like Rails: convention over configuration. Generators, scaffolds, sensible defaults — and full control when you need it.

- ✅ Show the simple path first, link to advanced options
- ❌ Show every option on one screen with a "Simple Mode" toggle

## The Rails Principle

Pinchy follows **Convention over Configuration** for AI agents:

| Concept | How Pinchy does it |
|---|---|
| Smart defaults | Agents work out of the box with pre-built personality templates |
| Templates over blank slates | Personality presets (like Rails generators) instead of "write your own SOUL.md" |
| Progressive disclosure | Simple UI by default, advanced config available but not required |
| Zero-config setup | Docker Compose up and you're running |

## Voice Characteristics

**We are:** Confident, helpful, clear, warm, occasionally witty.
**We are not:** Corporate, robotic, overly casual, condescending, anxious.

### Contractions: Yes.

"You'll see your agents here" not "You will see your agents here."

### Humor: Subtle.

The lobster/crab theme is our signature. Use it in loading states, empty states, and the occasional Easter egg. Never in error states or security contexts.

### Pronouns: "You" and "Your."

Talk to the user directly. Not "the user" or "one."

### Technical terms: Only when necessary.

Say "encrypted" not "AES-256-GCM encrypted" (unless in security docs). Say "your server" not "your self-hosted infrastructure."

## Writing by Context

### Empty States

Personality lives here. This is where Pinchy gets to be charming.

- Agent list (empty): "No agents yet. Create your first one — it only takes a minute."
- Chat (waiting): Rotating lobster-themed messages ("Polishing the shell...", "Checking the tide...")
- Audit log (empty): "Nothing here yet. That's a good thing."

### Error Messages

Be honest, be helpful, don't blame the user.

- ✅ "Something went wrong connecting to the agent. Try refreshing — if it persists, check the logs."
- ❌ "Error: WebSocket connection failed (code 1006)"
- ❌ "Oopsie! Something broke! 🦞"

### Success Messages

Brief, positive, no celebration overkill.

- ✅ "Agent created."
- ✅ "Settings saved."
- ❌ "🎉 Awesome! Your agent has been successfully created!"

### Tooltips & Help Text

One sentence. Plain language. Answer the question "what does this do?"

- ✅ "Controls who can see this agent's conversations."
- ❌ "This setting determines the visibility scope of agent interactions within the multi-user permission framework."

### Onboarding

Conversational. Guide, don't instruct. Feel like a colleague showing you around, not a manual.

- ✅ "Welcome to Pinchy. Your first agent is already here — say hello to Smithers."
- ❌ "Step 1: Review the default agent configuration. Step 2: Verify connectivity..."

### Security & Compliance Contexts

Drop the humor. Be precise and reassuring.

- ✅ "All API keys are encrypted at rest. They never leave your server."
- ❌ "Your keys are locked up tight! 🔒🦞"

### Documentation

Clear, scannable, example-driven. Show don't tell. Code samples over paragraphs.

## Agent Personality Templates

Agents are personalities, not tools. Every agent has a name and a character. Pinchy ships with curated personality presets so users don't have to write SOUL.md files from scratch:

- Users pick a template (e.g., "Professional Assistant", "Friendly Helper", "Technical Expert")
- Templates are fully customizable — change the name, tweak the personality, make it yours
- The default agent (Smithers) sets the tone: competent, polite, slightly formal, dry humor

When creating new personality templates, follow these principles:
- Give the personality a clear, consistent character trait
- Include example interactions so contributors understand the intended behavior
- Keep it professional enough for workplace use
- Make it distinct — each template should feel genuinely different

## The Pinchy Test

Before shipping any user-facing text, ask:

1. **Would a stressed CTO at 11pm understand this immediately?** (Clear)
2. **Does it feel like a product you'd enjoy using?** (Warm)
3. **Would you trust this product with your company's data?** (Secure)
4. **Could someone set this up without reading a manual?** (Simple)

If any answer is no, rewrite.
