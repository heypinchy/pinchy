import { defineConfig, passthroughImageService } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightClientMermaid from '@pasqal-io/starlight-client-mermaid';

export default defineConfig({
  site: 'https://docs.heypinchy.com',
  image: {
    service: passthroughImageService(),
  },
  integrations: [
    starlight({
      title: 'Pinchy',
      plugins: [starlightClientMermaid()],
      head: [
        ...(process.env.UMAMI_WEBSITE_ID ? [
          {
            tag: 'script',
            attrs: {
              defer: true,
              src: 'https://cloud.umami.is/script.js',
              'data-website-id': process.env.UMAMI_WEBSITE_ID,
            },
          },
        ] : []),
        {
          tag: 'meta',
          attrs: { property: 'og:image', content: 'https://docs.heypinchy.com/og-image.png' },
        },
        {
          tag: 'meta',
          attrs: { name: 'twitter:image', content: 'https://docs.heypinchy.com/og-image.png' },
        },
        {
          tag: 'script',
          attrs: { type: 'application/ld+json' },
          content: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: 'Pinchy Documentation',
            url: 'https://docs.heypinchy.com',
            publisher: {
              '@type': 'Organization',
              name: 'Helmcraft GmbH',
              url: 'https://heypinchy.com',
            },
            about: {
              '@type': 'SoftwareApplication',
              name: 'Pinchy',
              applicationCategory: 'DeveloperApplication',
              operatingSystem: 'Linux, Docker',
              license: 'https://www.gnu.org/licenses/agpl-3.0.html',
              offers: {
                '@type': 'Offer',
                price: '0',
                priceCurrency: 'USD',
              },
              author: {
                '@type': 'Person',
                name: 'Clemens Helm',
                url: 'https://clemenshelm.com',
              },
            },
            potentialAction: {
              '@type': 'SearchAction',
              target: 'https://docs.heypinchy.com/?search={search_term_string}',
              'query-input': 'required name=search_term_string',
            },
          }),
        },
        {
          tag: 'script',
          attrs: { type: 'application/ld+json' },
          content: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
              {
                '@type': 'ListItem',
                position: 1,
                name: 'Pinchy',
                item: 'https://heypinchy.com',
              },
              {
                '@type': 'ListItem',
                position: 2,
                name: 'Documentation',
                item: 'https://docs.heypinchy.com',
              },
            ],
          }),
        },
      ],
      logo: {
        src: './src/assets/pinchy-logo.png',
      },
      favicon: '/favicon.png',
      customCss: ['./src/styles/custom.css'],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/heypinchy/pinchy',
        },
      ],
      sidebar: [
        {
          label: 'Start Here',
          items: [
            { label: 'Introduction', slug: '' },
            { label: 'Quick Start', slug: 'getting-started' },
            { label: 'Installation', slug: 'installation' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Create a Knowledge Base Agent', slug: 'guides/create-knowledge-base-agent' },
            { label: 'Mount Data Directories', slug: 'guides/mount-data-directories' },
            { label: 'Hardening', slug: 'guides/hardening' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Architecture', slug: 'architecture' },
            { label: 'Philosophy', slug: 'concepts/philosophy' },
            { label: 'Agent Memory', slug: 'explanation/agent-memory' },
            { label: 'Agent Permissions', slug: 'concepts/agent-permissions' },
            { label: 'Audit Trail', slug: 'concepts/audit-trail' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'API Reference', slug: 'reference/api' },
            { label: 'SBOM', slug: 'reference/sbom' },
          ],
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/heypinchy/pinchy/edit/main/docs/',
      },
    }),
  ],
});
