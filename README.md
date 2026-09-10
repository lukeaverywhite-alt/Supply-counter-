# A.R.G.U.S.

**Asset Readiness & Gear Utility System** is a phone-first inventory and uniform-issuance application designed for Bethel Navy NJROTC supply operations.

This repository currently contains the first functional front-end prototype. It uses fictional demonstration records only; no uploaded roster names or unverified inventory quantities are included.

## Current prototype

- Installable PWA shell with an A.R.G.U.S. home-screen icon
- Fast physical counting with 1, 5, 10, and custom increments
- Draft counts that remain separate from official inventory
- Search by item name, category, size, or normalized CDMIS NIIN
- Inventory, cadet, activity, and administration views
- Fictional data for safe interface review
- Responsive phone, tablet, and desktop layouts

## Local development

```bash
npm install
npm run dev
```

## Checks

```bash
npm test
npm run test:coverage
npm run lint
npm run build
npm run test:deploy
```

## GitHub Pages deployment

The `Verify and deploy A.R.G.U.S.` workflow verifies and publishes the app whenever changes reach the `main` branch. It can also be started manually from the repository's **Actions** tab.

GitHub does not permit a workflow's built-in `GITHUB_TOKEN` to enable Pages on a repository where Pages has never been configured. For the first deployment, either open **Settings → Pages** and set **Source** to **GitHub Actions**, or create a fine-grained personal access token with **Administration: write** and **Pages: write** access to this repository and save it as the repository Actions secret `PAGES_TOKEN`. The workflow uses that secret to enable Pages automatically; after the site exists, its built-in token handles normal deployments.

The workflow then:

1. installs the locked dependencies with `npm ci` on Node.js 24;
2. runs the test and lint suites;
3. creates a production build;
4. serves that build from a simulated repository subdirectory and verifies every deployment asset; and
5. publishes the verified `dist` directory to GitHub Pages.

The build uses relative asset paths so the installed app, manifest, icon, and service worker work from the repository's GitHub Pages subdirectory as well as a future custom domain.

## Product boundary

Authentication, shared real-time counting, production roster imports, backend persistence, and authoritative audit storage require the planned backend phase. The current local prototype intentionally does not claim to provide those security guarantees.
