/**
 * Starter repository template for CODE GIFTZ engineering workspaces (Phase 4).
 *
 * This is a REAL, runnable bun/TypeScript project — not a mock. It contains a
 * small library, an entry point, a test suite and package scripts. One seeded
 * defect (`sumAmounts` folds debits into credits via Math.abs, so
 * `bun test` FAILS on arrival) gives the agent a genuine fix-and-verify golden
 * path: inspect → plan → approve → edit → `bun test` flips from failing to
 * passing → reviewable diff.
 */

export interface TemplateFile {
  path: string;
  content: string;
}

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "lib": ["ES2022"]
  },
  "include": ["src", "tests"]
}
`;

const PACKAGE_JSON = `{
  "name": "ledger-kit",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  }
}
`;

const README = `# ledger-kit

Small ledger arithmetic helpers used by the sample workspace.

## Scripts

- \`bun test\` — run the unit tests
- \`bun run typecheck\` — TypeScript check

## Layout

- \`src/index.ts\` — public entry point
- \`src/lib/ledger.ts\` — ledger math
- \`tests/ledger.test.ts\` — unit tests
`;

const LEDGER_TS = `export interface Entry {
  label: string;
  amount: number;
}

/**
 * Sum a list of amounts, keeping each entry's sign (credits add, debits
 * subtract).
 *
 * KNOWN DEFECT: the loop folds every amount through Math.abs, so negative
 * entries are counted as credits and the total is wrong whenever a debit
 * exists. See tests/ledger.test.ts — "sumAmounts keeps each entry's sign".
 */
export function sumAmounts(entries: Entry[]): number {
  let total = 0;
  for (const entry of entries) {
    total += Math.abs(entry.amount);
  }
  return total;
}

/** Net balance: credits minus debits. */
export function netBalance(entries: Entry[]): number {
  let total = 0;
  for (const entry of entries) {
    total += entry.amount;
  }
  return total;
}

/** Format an amount with a sign and two decimals. */
export function formatAmount(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return \`\${sign}\${Math.abs(amount).toFixed(2)}\`;
}
`;

const INDEX_TS = `export { sumAmounts, netBalance, formatAmount, type Entry } from "./lib/ledger";
`;

// Ambient declaration so the workspace typechecks with plain `tsc --noEmit`
// without any installed dependencies. Bun injects the real "bun:test" module
// at runtime; this file only describes it for the compiler.
const BUN_TEST_TYPES = `declare module "bun:test" {
  export interface Matcher {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
  }
  export function expect(actual: unknown): Matcher;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}
`;

const TEST_TS = `import { describe, expect, test } from "bun:test";
import { sumAmounts, netBalance, formatAmount, type Entry } from "../src/index";

const mixed: Entry[] = [
  { label: "invoice", amount: 120 },
  { label: "refund", amount: -30 },
  { label: "fee", amount: -5 },
];

describe("ledger-kit", () => {
  test("sumAmounts keeps each entry's sign (credits add, debits subtract)", () => {
    expect(sumAmounts(mixed)).toBe(85);
  });

  test("sumAmounts of an all-credit list equals the plain total", () => {
    expect(sumAmounts([{ label: "a", amount: 10 }, { label: "b", amount: 5 }])).toBe(15);
  });

  test("netBalance credits minus debits", () => {
    expect(netBalance(mixed)).toBe(85);
  });

  test("formatAmount keeps the sign and two decimals", () => {
    expect(formatAmount(-30)).toBe("-30.00");
    expect(formatAmount(120)).toBe("120.00");
  });
});
`;

export const STARTER_TEMPLATE_NAME = "ledger-kit starter";

export function starterTemplateFiles(): TemplateFile[] {
  return [
    { path: "package.json", content: PACKAGE_JSON },
    { path: "tsconfig.json", content: TSCONFIG },
    { path: "README.md", content: README },
    { path: ".gitignore", content: "node_modules/\ndist/\n*.log\n.env\n" },
    { path: "src/index.ts", content: INDEX_TS },
    { path: "src/types/bun-test.d.ts", content: BUN_TEST_TYPES },
    { path: "src/lib/ledger.ts", content: LEDGER_TS },
    { path: "tests/ledger.test.ts", content: TEST_TS },
  ];
}
