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
npm run lint
npm run build
```

## Product boundary

Authentication, shared real-time counting, production roster imports, backend persistence, and authoritative audit storage require the planned backend phase. The current local prototype intentionally does not claim to provide those security guarantees.
