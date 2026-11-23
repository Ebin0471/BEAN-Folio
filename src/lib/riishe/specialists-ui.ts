/**
 * M31 — client-safe specialist display names.
 *
 * Deliberately SEPARATE from src/lib/riishe/specialists.ts: that module
 * imports the tool registry (which imports the Prisma client), and must
 * never enter the client bundle. This module carries only the BEAN identity
 * names — the UI never shows provider/model/backend labels.
 */
export const SPECIALIST_NAME_BY_ID: Record<string, string> = {
  "career-guide": "Career Guide",
  "talent-scout": "Talent Scout",
  "project-manager": "Project Manager",
  "research-analyst": "Research Analyst",
  "business-operations": "Business Operations",
  "growth-communications": "Growth & Communications",
  "business-analyst": "Business Analyst",
  "people-operations": "People Operations",
  "docs-knowledge": "Document & Knowledge Assistant",
};
