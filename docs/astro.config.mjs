import { defineConfig, passthroughImageService } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightMermaid from "./src/integrations/mermaid/index.mjs";

export default defineConfig({
  site: "https://docs.heypinchy.com",
  image: {
    service: passthroughImageService(),
  },
  // No `markdown.gfm` here, on purpose. Under astro@6 it had to be stated:
  // @astrojs/mdx@5 read the deprecated option, got `undefined`, and every .mdx
  // table shipped as a paragraph of literal `|` characters (v0.9.0). Under
  // astro@7 both `.md` and `.mdx` go through Sätteri, whose MDX renderer
  // resolves an unset gfm to `true` — and astro@7 warns on the option. Measured
  // when it was removed (#851): without it every table renders; with
  // `gfm: false` check:rendered fails on 47 pages, so the guard still sees it.
  // `pnpm -C docs check:rendered` is the proof either way; run it after any
  // change to how markdown is processed.
  redirects: {
    // Brief-lived alternate URL added by the openclaw-tmpfs PR before
    // v0.5.0 shipped. Content was consolidated into /guides/upgrading/.
    "/upgrade-notes/v0.5.0": "/guides/upgrading",
    // The standalone v0.5.5 upgrade-notes page was removed; its content is
    // covered by /guides/upgrading/.
    "/upgrading/v0-5-5": "/guides/upgrading",
  },
  integrations: [
    starlight({
      title: "Pinchy",
      plugins: [starlightMermaid()],
      head: [
        ...(process.env.UMAMI_WEBSITE_ID
          ? [
              {
                tag: "script",
                attrs: {
                  defer: true,
                  src: "https://analytics.helmcraft.ai/script.js",
                  "data-website-id": process.env.UMAMI_WEBSITE_ID,
                },
              },
            ]
          : []),
        {
          tag: "link",
          attrs: {
            rel: "alternate",
            type: "application/rss+xml",
            title: "Pinchy Releases",
            href: "https://github.com/heypinchy/pinchy/releases.atom",
          },
        },
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: "https://docs.heypinchy.com/og-image.png",
          },
        },
        {
          tag: "meta",
          attrs: {
            name: "twitter:image",
            content: "https://docs.heypinchy.com/og-image.png",
          },
        },
        {
          tag: "script",
          attrs: { type: "application/ld+json" },
          content: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "WebSite",
            name: "Pinchy Documentation",
            url: "https://docs.heypinchy.com",
            publisher: {
              "@type": "Organization",
              name: "Helmcraft GmbH",
              url: "https://heypinchy.com",
            },
            about: {
              "@type": "SoftwareApplication",
              name: "Pinchy",
              applicationCategory: "DeveloperApplication",
              operatingSystem: "Linux, Docker",
              license: "https://www.gnu.org/licenses/agpl-3.0.html",
              offers: {
                "@type": "Offer",
                price: "0",
                priceCurrency: "USD",
              },
              author: {
                "@type": "Person",
                name: "Clemens Helm",
                url: "https://clemenshelm.com",
              },
            },
            potentialAction: {
              "@type": "SearchAction",
              target: "https://docs.heypinchy.com/?search={search_term_string}",
              "query-input": "required name=search_term_string",
            },
          }),
        },
        {
          tag: "script",
          attrs: { type: "application/ld+json" },
          content: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              {
                "@type": "ListItem",
                position: 1,
                name: "Pinchy",
                item: "https://heypinchy.com",
              },
              {
                "@type": "ListItem",
                position: 2,
                name: "Documentation",
                item: "https://docs.heypinchy.com",
              },
            ],
          }),
        },
      ],
      logo: {
        src: "./src/assets/pinchy-logo.svg",
      },
      favicon: "/favicon.png",
      customCss: ["./src/styles/custom.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/heypinchy/pinchy",
        },
      ],
      sidebar: [
        {
          label: "Start Here",
          items: [
            { label: "Introduction", slug: "" },
            { label: "Quick Start", slug: "getting-started" },
            {
              label: "Your First Governed Agent",
              slug: "tutorials/first-governed-agent",
            },
            { label: "Installation", slug: "installation" },
            { label: "Releases", slug: "releases" },
          ],
        },
        {
          label: "Guides",
          items: [
            {
              label: "Create a Knowledge Base Agent",
              slug: "guides/create-knowledge-base-agent",
            },
            {
              label: "Create a Market & News Monitor",
              slug: "guides/create-market-monitor-agent",
            },
            {
              label: "Require Tool Confirmation",
              slug: "guides/tool-confirmation",
            },
            {
              label: "Mount Data Directories",
              slug: "guides/mount-data-directories",
            },
            { label: "User Management", slug: "guides/user-management" },
            {
              label: "Smithers Onboarding",
              slug: "guides/smithers-onboarding",
            },
            { label: "Manage LLM Providers", slug: "guides/llm-providers" },
            { label: "Set Up Telegram", slug: "guides/telegram-setup" },
            { label: "Set Up Local Ollama", slug: "guides/ollama-setup" },
            {
              label: "Usage & Costs Dashboard",
              slug: "guides/usage-dashboard",
            },
            {
              label: "Keep Costs Predictable",
              slug: "guides/cost-governance",
            },
            { label: "Enterprise Setup", slug: "guides/enterprise-setup" },
            { label: "VPS Deployment", slug: "guides/vps-deployment" },
            { label: "Deploy on Hetzner Cloud", slug: "guides/deploy-hetzner" },
            {
              label: "Deploy on DigitalOcean",
              slug: "guides/deploy-digitalocean",
            },
            { label: "Upgrading", slug: "guides/upgrading" },
            {
              label: "Customizing Your Deployment",
              slug: "guides/customizing-deployment",
            },
            { label: "Hardening", slug: "guides/hardening" },
            { label: "HTTPS & Domain Lock", slug: "guides/domain-lock" },
            {
              label: "Connect Email",
              items: [
                { label: "Overview", slug: "guides/connect-email" },
                {
                  label: "Google (Gmail)",
                  slug: "guides/connect-email-google",
                },
                {
                  label: "Microsoft (Outlook / Microsoft 365)",
                  slug: "guides/connect-email-microsoft",
                },
                {
                  label: "IMAP / Other email",
                  slug: "guides/connect-email-imap",
                },
              ],
            },
            {
              label: "Set Up Email Automations",
              slug: "guides/email-automations",
            },
            { label: "Connect Odoo", slug: "guides/connect-odoo" },
            { label: "Upload Files in Chat", slug: "guides/file-uploads" },
            { label: "Install as an App", slug: "guides/install-as-app" },
            {
              label: "Share to Pinchy from Your Phone",
              slug: "guides/share-to-pinchy",
            },
            { label: "Set Up Web Search", slug: "guides/web-search-setup" },
            {
              label: "Message Delivery & Retry",
              slug: "guides/retry-messages",
            },
            { label: "Slash Commands in Chat", slug: "guides/slash-commands" },
            { label: "Image Attachments", slug: "guides/image-attachments" },
            { label: "Reporting Issues", slug: "guides/reporting-issues" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Architecture", slug: "architecture" },
            { label: "Philosophy", slug: "concepts/philosophy" },
            { label: "Agent Memory", slug: "explanation/agent-memory" },
            {
              label: "Instructions vs. Memory",
              slug: "explanation/instructions-vs-memory",
            },
            {
              label: "Skills & Templates",
              slug: "explanation/skills-and-templates",
            },
            {
              label: "Chat Connection States",
              slug: "explanation/chat-states",
            },
            { label: "Agent Settings", slug: "concepts/agent-settings" },
            { label: "Agent Permissions", slug: "concepts/agent-permissions" },
            { label: "Agent Workspaces", slug: "concepts/workspaces" },
            { label: "Context Management", slug: "concepts/context" },
            { label: "User Roles", slug: "concepts/user-roles" },
            { label: "Groups", slug: "concepts/groups" },
            { label: "Audit Trail", slug: "concepts/audit-trail" },
            {
              label: "Verifying the Audit Trail",
              slug: "concepts/audit-trail-verification",
            },
            { label: "AI Disclosure", slug: "concepts/ai-disclosure" },
            { label: "Attachments", slug: "concepts/attachments" },
            { label: "Integrations", slug: "concepts/integrations" },
          ],
        },
        {
          label: "Glossary",
          items: [
            { label: "AI Agent Platform", slug: "glossary/ai-agent-platform" },
            { label: "What Is OpenClaw?", slug: "glossary/what-is-openclaw" },
            {
              label: "AI Agent Governance",
              slug: "glossary/ai-agent-governance",
            },
            {
              label: "AI Agent Permissions",
              slug: "glossary/ai-agent-permissions",
            },
            {
              label: "RBAC for AI Agents",
              slug: "glossary/rbac-for-ai-agents",
            },
            {
              label: "AI Agent Audit Trail",
              slug: "glossary/ai-agent-audit-trail",
            },
            {
              label: "Self-Hosted AI Agents",
              slug: "glossary/self-hosted-ai-agents",
            },
            {
              label: "Air-Gapped AI Agents",
              slug: "glossary/air-gapped-ai-agents",
            },
            { label: "GDPR & AI Agents", slug: "glossary/gdpr-ai-agents" },
            {
              label: "Local LLMs for Business",
              slug: "glossary/local-llm-for-business",
            },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "API Reference", slug: "reference/api" },
            {
              label: "Environment Variables",
              slug: "reference/environment-variables",
            },
            {
              label: "Agent Provisioning API",
              slug: "reference/agent-provisioning-api",
            },
            {
              label: "Organization Timezone",
              slug: "reference/organization-timezone",
            },
            { label: "SBOM", slug: "reference/sbom" },
            { label: "Secret Handling", slug: "security/secrets" },
          ],
        },
      ],
      editLink: {
        baseUrl: "https://github.com/heypinchy/pinchy/edit/main/docs/",
      },
    }),
  ],
});
