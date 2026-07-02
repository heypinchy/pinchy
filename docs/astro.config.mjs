import { defineConfig, passthroughImageService } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightClientMermaid from "@pasqal-io/starlight-client-mermaid";

export default defineConfig({
  site: "https://docs.heypinchy.com",
  image: {
    service: passthroughImageService(),
  },
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
      plugins: [starlightClientMermaid()],
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
            { label: "Connect Email (Gmail)", slug: "guides/connect-email" },
            { label: "Connect Odoo", slug: "guides/connect-odoo" },
            { label: "Upload Files in Chat", slug: "guides/file-uploads" },
            { label: "Install as an App", slug: "guides/install-as-app" },
            { label: "Set Up Web Search", slug: "guides/web-search-setup" },
            {
              label: "Message Delivery & Retry",
              slug: "guides/retry-messages",
            },
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
            { label: "SBOM", slug: "reference/sbom" },
          ],
        },
      ],
      editLink: {
        baseUrl: "https://github.com/heypinchy/pinchy/edit/main/docs/",
      },
    }),
  ],
});
