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
- Use `npm version patch --no-git-tag-version` (or the appropriate semver increment) to prepare a release.

## Preparing a public release

Publishing requires an explicit release decision. Run the checks above and
`npm pack --dry-run`, then commit and push the version change to `main`. Create
and push the matching `vX.Y.Z` tag to trigger `.github/workflows/publish.yml`.
The publishing workflow builds and inspects the package, then publishes through
npm trusted publishing with provenance. It does not run the Linux/macOS test
matrix. It verifies that the tag matches the stable package
version and that its commit belongs to `main`.

The npm trusted publisher must identify GitHub owner `TheNaubit`, repository
`astro-bun`, workflow `publish.yml`, no environment, and allow direct publishing.
No npm token secret is required. Keep the repository public for provenance.
Version `0.1.0` was published manually without provenance; subsequent releases
use the workflow. Already published versions cannot be reused.

The package already includes `astro-integration` and `withastro` for discovery and
`astro-adapter` for the Adapters category. Astro reads `name`, `description`, `repository`,
and `homepage` from the published npm metadata. Its library imports matching published
packages weekly; preparing this metadata does not mean the package is listed or endorsed.
See [Astro's integrations library requirements](https://docs.astro.build/en/guides/integrations/#integrations-library).
