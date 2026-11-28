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
  // M35: the Creative Producer identity (attribution honesty — workflows it
  // owns show its chip, not a fallback).
  "creative-producer": "Creative Producer",
  // M36.1: the two new registered specialists.
  "people-finder": "People Finder",
  "portfolio-intelligence": "Portfolio Intelligence Analyst",
  // M36.2: the ORGANIZATION hiring-request specialist (display-name record
  // was completed additively in M36.3 — the workflow chip previously fell
  // back to the generic label).
  "workforce-strategist": "Workforce Strategist",
  // M36.3: the ORGANIZATION match-explanation specialist.
  "talent-intelligence": "Talent Intelligence Analyst",
  // M36.4: the ORGANIZATION prepare-only hiring-coordination specialist.
  "candidate-relations": "Candidate Relations Agent",
  // M36.6: the two GIFTZ specialists (website architecture + static quality
  // audit — display-name record only).
  "giftz-product-architect": "GIFTZ Product Architect",
  "giftz-quality-auditor": "GIFTZ Experience & Quality Auditor",
};
