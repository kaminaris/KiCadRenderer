This folder contains lightweight unit test stubs for shared/kicad-render utilities.

Running tests locally

These are TypeScript test files. A few recommended ways to run them locally:

1) ts-node (quick, no install beyond dev deps):
   - Install: npm install -D ts-node typescript @types/node
   - Run: node -r ts-node/register tests/utils.test.ts

2) Vitest / Jest (preferred for larger suites):
   - Add a runner and configure a script in package.json.

The tests intentionally avoid adding new test framework dependencies here. Run the commands above from the package root that owns the workspace (monorepo root).
