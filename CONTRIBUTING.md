# Contributing

Contributions of any kind are welcome. Keep changes focused and preserve the adapter's guarantees for static output, SSR, and ISR.

## Setup

Install the Bun version declared by the repository's CI workflow, then run:

```bash
git clone git@github.com:TheNaubit/astro-bun.git
cd astro-bun
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run check
bun test
bun run build
```

The build output goes to `dist/`.

## Rules

- Write a failing test first for behavior changes and bug fixes. Cover each affected rendering mode: static output, SSR, or ISR.
- Prefer Bun-native APIs where they satisfy Astro's adapter contract. Do not add a compatibility layer or runtime dependency without a documented need.
- Treat project configuration and request data as untrusted at their boundaries. Do not introduce shell execution, dynamic imports from request data, or unsafe filesystem paths.
- Format with `bun run format` and make `bun run lint` pass before opening a pull request.
- Keep documentation accurate when public behavior changes.
- Use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, or `ci:`.
- Do not change `version` by hand. This private repository has no publishing workflow.

## Preparing a public release

The repository and package are currently private. Publishing is a separate release decision.
Before a public release, make the GitHub repository public, remove `private: true` from
`package.json`, update the README installation instructions for the npm release, and run
all checks plus `npm pack --dry-run`. Publish the scoped package with public access and
provenance using a reviewed release workflow or a maintainer session.

The package already includes `astro-integration` and `withastro` for discovery and
`astro-adapter` for the Adapters category. Astro reads `name`, `description`, `repository`,
and `homepage` from the published npm metadata. Its library imports matching published
packages weekly; preparing this metadata does not mean the package is listed or endorsed.
See [Astro's integrations library requirements](https://docs.astro.build/en/guides/integrations/#integrations-library).
