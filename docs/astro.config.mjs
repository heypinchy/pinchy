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
      head: process.env.UMAMI_WEBSITE_ID ? [
        {
          tag: 'script',
          attrs: {
            defer: true,
            src: 'https://cloud.umami.is/script.js',
            'data-website-id': process.env.UMAMI_WEBSITE_ID,
          },
        },
      ] : [],
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
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Architecture', slug: 'architecture' },
            { label: 'Agent Permissions', slug: 'concepts/agent-permissions' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'API Reference', slug: 'reference/api' },
          ],
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/heypinchy/pinchy/edit/main/docs/',
      },
    }),
  ],
});
