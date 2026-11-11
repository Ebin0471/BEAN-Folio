/**
 * Shared fixtures for the Phase 4 route tests (kept out of the test file so
 * the mock.module factory can import it without circular mock issues).
 */

export function validPlanFixture() {
  const fixedLedger = `export interface Entry {
  label: string;
  amount: number;
}

export function sumAmounts(entries: Entry[]): number {
  let total = 0;
  for (const entry of entries) {
    total += entry.amount;
  }
  return total;
}

export function netBalance(entries: Entry[]): number {
  let total = 0;
  for (const entry of entries) {
    total += entry.amount;
  }
  return total;
}

export function formatAmount(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return \`\${sign}\${Math.abs(amount).toFixed(2)}\`;
}
`;
  return {
    fixedLedger,
    plan: {
      objective: "Fix sumAmounts so debits subtract",
      problemDescription: "sumAmounts folds every amount through Math.abs, so negative entries are counted as credits and totals are wrong whenever a debit exists.",
      rootCauseHypothesis: "Math.abs applied to entry.amount in the accumulation loop.",
      files: [{ path: "src/lib/ledger.ts", change: "modify", reason: "Remove the Math.abs folding in sumAmounts" }],
      steps: [
        { id: "fix-ledger", title: "Fix sumAmounts", kind: "modify_file", path: "src/lib/ledger.ts", detail: "Accumulate entry.amount without Math.abs.", dependsOn: [], risk: "low" },
        { id: "run-tests", title: "Run the test suite", kind: "run_command", command: "unit tests", detail: "bun test must pass.", dependsOn: ["fix-ledger"], risk: "low" },
      ],
      dependencies: [],
      risks: [],
      validation: { strategy: "Run the unit tests", commands: [{ label: "unit tests", argv: ["bun", "test"] }] },
      expectedOutcome: "All ledger-kit tests pass.",
    },
  };
}
