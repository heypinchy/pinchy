import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { githubReleasesLoader } from 'astro-loader-github-releases';

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema(),
  }),
  // Releases are pulled live from GitHub at build time — the single source of
  // truth. No hand-maintained copy. The loader reads GITHUB_TOKEN from the
  // environment when present (CI provides it automatically, lifting the API
  // rate limit); unauthenticated build requests are fine at our build cadence.
  releases: defineCollection({
    loader: githubReleasesLoader({
      repos: ['heypinchy/pinchy'],
      entryReturnType: 'byRelease',
    }),
  }),
};
