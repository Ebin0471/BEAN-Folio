import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";

// O1 navigation & onboarding contract tests (static, read-only).
//
// These pin the OWNER-DIRECTED navigation requirements at the source level so
// future edits cannot silently unmount the Opportunity Exchange pillar or
// break the existing destinations:
//   - Opportunity Exchange is a separate, permanent, top-level destination in
//     the main navigation (own route, own icon, auth-gated router case);
//   - every pre-existing destination is preserved (desktop NAV + mobile bar);
//   - the mobile bottom bar uses the responsive "More" overflow pattern
//     instead of squeezing eight destinations into unusable tap targets;
//   - Trust & settings stays reachable through the existing conventions;
//   - the OX views and API routes exist and follow the repository conventions.

const SHELL = "src/components/bean/SiteShell.tsx";
const shell = readFileSync(SHELL, "utf8");

const EXISTING_DESKTOP_ROUTES = ["/", "/explore", "/studio", "/intelligence", "/laxii", "/giftz", "/connect"];
const EXISTING_MOBILE_ROUTES = ["/", "/explore", "/studio", "/intelligence", "/laxii", "/giftz", "/connect"];

describe("Opportunity Exchange navigation registration", () => {
  test("desktop NAV adds /opportunities with its own icon without removing any existing destination", () => {
    expect(shell).toContain('href: "/opportunities", label: "Opportunities", icon: Briefcase');
    for (const route of EXISTING_DESKTOP_ROUTES) {
      expect(shell).toContain(`href: "${route}"`);
    }
    // icon import exists
    expect(shell).toMatch(/import \{[^}]*\bBriefcase\b[^}]*\} from "lucide-react"/);
  });

  test("the mobile bottom bar keeps the seven established destinations and adds ONE More entry", () => {
    // grid-cols-8 = 7 destinations + More (never 8 squeezed destinations)
    expect(shell).toContain("grid-cols-8");
    for (const route of EXISTING_MOBILE_ROUTES) {
      expect(shell).toContain(`href: "${route}"`);
    }
    expect(shell).toContain("MOBILE_MORE_ITEMS");
    expect(shell).toContain('aria-label="More destinations"');
    // the sheet is a Sheet (bottom) with an accessible title
    expect(shell).toContain('<SheetContent side="bottom"');
    expect(shell).toContain("<SheetTitle>More destinations</SheetTitle>");
  });

  test("Opportunity Exchange leads the More sheet, visibly independent and labeled", () => {
    const moreBlock = shell.slice(shell.indexOf("MOBILE_MORE_ITEMS"), shell.indexOf("// ---------------------------------------------------------------- helpers"));
    expect(moreBlock).toContain('href: "/opportunities"');
    expect(moreBlock).toContain('label: "Opportunity Exchange"');
    expect(moreBlock).toContain("emphasize: true");
    // Trust & settings remains reachable via the existing conventions (menu + sheet)
    expect(moreBlock).toContain('href: "/settings"');
    expect(moreBlock).toContain('label: "Trust & settings"');
  });

  test("More highlights when the current route lives in the overflow sheet", () => {
    expect(shell).toContain('MOBILE_MORE_ROOTS = new Set(["opportunities", "folio", "collections", "insights", "settings", "moderation"])');
  });

  test("the router case is auth-gated and the private route label is registered", () => {
    expect(shell).toMatch(/case "opportunities":\s*\n[\s\S]*?<RequireAuth label="Opportunity Exchange"><OpportunityExchangeView \/><\/RequireAuth>;/);
    expect(shell).toContain('opportunities: "Opportunity Exchange"');
  });

  test("UserMenu still offers My Folio, Create Studio, Insights and Trust & settings", () => {
    expect(shell).toContain('navigate("/folio")');
    expect(shell).toContain('navigate("/studio")');
    expect(shell).toContain('navigate("/insights")');
    expect(shell).toContain('navigate("/settings")');
  });
});

describe("OX views and routes exist and follow repository conventions", () => {
  const SETUP = "src/views/ox/OxEmployerSetupView.tsx";
  const LANDING = "src/views/ox/OpportunityExchangeView.tsx";
  const ADMIN_PANEL = "src/views/ox/OxAdminVerificationPanel.tsx";

  test("the OX view files exist and are wired to the OX APIs", () => {
    expect(existsSync(SETUP)).toBe(true);
    expect(existsSync(LANDING)).toBe(true);
    expect(existsSync(ADMIN_PANEL)).toBe(true);
    const setup = readFileSync(SETUP, "utf8");
    expect(setup).toContain('"/api/employers"');
    expect(setup).toContain('"/api/employers/me"');
    // onboarding empty state + loading skeletons + toasts exist
    expect(setup).toContain("<EmptyState");
    expect(setup).toContain("<Skeleton");
    expect(setup).toContain("toast.success");
    expect(setup).toContain("toast.error");
    // transfer dialog collects the password (re-authentication)
    expect(setup).toContain('type="password"');
    const landing = readFileSync(LANDING, "utf8");
    expect(landing).toContain("Opportunity Exchange");
    expect(landing).toContain("<OxEmployerSetupView />");
  });

  test("the admin verification panel is wired into the existing admin view, admin-gated", () => {
    const moderation = readFileSync("src/views/ModerationView.tsx", "utf8");
    expect(moderation).toContain("OxAdminVerificationPanel");
    expect(moderation).toContain("isAdmin && <OxAdminVerificationPanel />");
    const panel = readFileSync(ADMIN_PANEL, "utf8");
    expect(panel).toContain("/api/admin/ox/verifications");
    // reject decisions require a reason client-side too
    expect(panel).toContain("rejectReason");
  });

  const ROUTES: { file: string; methods: string[] }[] = [
    { file: "src/app/api/employers/route.ts", methods: ["POST"] },
    { file: "src/app/api/employers/me/route.ts", methods: ["GET"] },
    { file: "src/app/api/employers/[id]/route.ts", methods: ["PATCH"] },
    { file: "src/app/api/employers/[id]/members/route.ts", methods: ["GET", "POST"] },
    { file: "src/app/api/employers/[id]/members/[memberId]/route.ts", methods: ["PATCH"] },
    { file: "src/app/api/employers/[id]/verification/route.ts", methods: ["POST"] },
    { file: "src/app/api/employers/[id]/transfer-ownership/route.ts", methods: ["POST"] },
    { file: "src/app/api/admin/ox/verifications/route.ts", methods: ["GET"] },
    { file: "src/app/api/admin/ox/verifications/[id]/route.ts", methods: ["GET", "PATCH"] },
    // M-O6 — employer invitations namespace
    { file: "src/app/api/opportunities/invitations/route.ts", methods: ["GET", "POST"] },
    { file: "src/app/api/opportunities/invitations/[invitationId]/route.ts", methods: ["GET", "PATCH", "DELETE"] },
    { file: "src/app/api/opportunities/invitations/[invitationId]/send/route.ts", methods: ["POST"] },
    { file: "src/app/api/opportunities/invitations/[invitationId]/withdraw/route.ts", methods: ["POST"] },
    { file: "src/app/api/opportunities/invitations/[invitationId]/negotiations/route.ts", methods: ["POST"] },
    { file: "src/app/api/opportunities/invitations/[invitationId]/negotiations/[negotiationId]/accept/route.ts", methods: ["POST"] },
    { file: "src/app/api/opportunities/invitations/[invitationId]/negotiations/[negotiationId]/decline/route.ts", methods: ["POST"] },
    { file: "src/app/api/opportunities/invitations/[invitationId]/negotiations/[negotiationId]/withdraw/route.ts", methods: ["POST"] },
    // M-O6 — candidate invitations namespace (recipient-only mirror)
    { file: "src/app/api/opportunities/me/invitations/route.ts", methods: ["GET"] },
    { file: "src/app/api/opportunities/me/invitations/[invitationId]/route.ts", methods: ["GET"] },
    { file: "src/app/api/opportunities/me/invitations/[invitationId]/accept/route.ts", methods: ["POST"] },
    { file: "src/app/api/opportunities/me/invitations/[invitationId]/decline/route.ts", methods: ["POST"] },
    { file: "src/app/api/opportunities/me/invitations/[invitationId]/negotiation-request/route.ts", methods: ["POST"] },
    { file: "src/app/api/opportunities/me/invitations/[invitationId]/negotiations/route.ts", methods: ["POST"] },
    { file: "src/app/api/opportunities/me/invitations/[invitationId]/negotiations/[negotiationId]/accept/route.ts", methods: ["POST"] },
    { file: "src/app/api/opportunities/me/invitations/[invitationId]/negotiations/[negotiationId]/decline/route.ts", methods: ["POST"] },
    { file: "src/app/api/opportunities/me/invitations/[invitationId]/negotiations/[negotiationId]/withdraw/route.ts", methods: ["POST"] },
  ];

  test("every OX route file exists with the expected exports and house conventions", () => {
    for (const route of ROUTES) {
      expect(existsSync(route.file)).toBe(true);
      const src = readFileSync(route.file, "utf8");
      expect(src).toContain('export const dynamic = "force-dynamic"');
      expect(src).toContain("handler(");
      for (const method of route.methods) {
        expect(src).toContain(`export const ${method} = handler(`);
      }
      // mutations carry CSRF defense-in-depth + validated bodies + rate limits
      const isMutation = route.methods.some((m) => m !== "GET");
      if (isMutation) {
        expect(src).toContain("sameOriginOk");
        expect(src).toContain("parseBody");
        expect(src).toContain("rateLimitShared");
      }
      // identity always comes from the session/admin helper — never the client
      expect(src).toMatch(/getSessionUser|requireAdmin/);
    }
  });

  test("OX routes audit sensitive actions and never hand-write role vocabulary", () => {
    for (const route of ROUTES) {
      const src = readFileSync(route.file, "utf8");
      const isMutation = route.methods.some((m) => m !== "GET");
      if (isMutation) {
        // M-O6 routes delegate every transition (and its in-transaction
        // auditOX write) to the audited invitation engine — importing it is
        // the audited path; direct auditOX usage covers all other surfaces.
        expect(src).toMatch(/auditOX|auditModeration|@\/lib\/ox\/invitation/);
      }
      // shared validation module is the single vocabulary source
      if (route.file.includes("employers") || route.file.includes("admin/ox")) {
        expect(src).toMatch(/@\/lib\/ox\/(validation|dto|authz|audit)/);
      }
    }
  });

  test("the schema carries the three O1 employer-identity tables in BOTH schema files", () => {
    for (const schema of ["prisma/schema.prisma", "prisma/schema.postgres.prisma"]) {
      const src = readFileSync(schema, "utf8");
      expect(src).toContain("model EmployerOrganization {");
      expect(src).toContain("model EmployerMembership {");
      expect(src).toContain("model EmployerVerification {");
      // the User back-references exist in both files
      expect(src).toContain('employerOrganizationsCreated EmployerOrganization[] @relation("employerOrgCreator")');
      expect(src).toContain('employerMemberships          EmployerMembership[]   @relation("employerMemberships")');
      expect(src).toContain('employerVerificationReviews  EmployerVerification[] @relation("employerVerifications")');
    }
  });
});
