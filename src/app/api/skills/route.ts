import { ok, handler } from "@/lib/api-helpers";
import { db } from "@/lib/db";

/** Curated starter skills — seed-on-read keeps the table populated on first request. */
const SKILL_SEED: { slug: string; label: string }[] = [
  { slug: "adobe-premiere", label: "Adobe Premiere Pro" },
  { slug: "after-effects", label: "After Effects" },
  { slug: "davinci-resolve", label: "DaVinci Resolve" },
  { slug: "figma", label: "Figma" },
  { slug: "photoshop", label: "Photoshop" },
  { slug: "illustrator", label: "Illustrator" },
  { slug: "blender", label: "Blender" },
  { slug: "sketchup", label: "SketchUp" },
  { slug: "autocad", label: "AutoCAD" },
  { slug: "revit", label: "Revit" },
  { slug: "react", label: "React" },
  { slug: "typescript", label: "TypeScript" },
  { slug: "python", label: "Python" },
  { slug: "nodejs", label: "Node.js" },
  { slug: "copywriting", label: "Copywriting" },
  { slug: "editing", label: "Editing" },
  { slug: "color-grading", label: "Color Grading" },
  { slug: "cinematography", label: "Cinematography" },
  { slug: "portrait-photography", label: "Portrait Photography" },
  { slug: "food-photography", label: "Food Photography" },
  { slug: "brand-design", label: "Brand Design" },
  { slug: "typography", label: "Typography" },
  { slug: "ux-research", label: "UX Research" },
  { slug: "prototyping", label: "Prototyping" },
  { slug: "watercolor", label: "Watercolor" },
  { slug: "oil-painting", label: "Oil Painting" },
  { slug: "digital-illustration", label: "Digital Illustration" },
  { slug: "teaching", label: "Teaching" },
  { slug: "curriculum-design", label: "Curriculum Design" },
  { slug: "menu-development", label: "Menu Development" },
  { slug: "pastry", label: "Pastry" },
  { slug: "seo", label: "SEO" },
  { slug: "content-strategy", label: "Content Strategy" },
  { slug: "project-management", label: "Project Management" },
  { slug: "sound-design", label: "Sound Design" },
  { slug: "mixing", label: "Mixing" },
  { slug: "pattern-making", label: "Pattern Making" },
  { slug: "sketching", label: "Sketching" },
  { slug: "3d-rendering", label: "3D Rendering" },
  { slug: "data-analysis", label: "Data Analysis" },
];

export const GET = handler(async () => {
  let rows = await db.skill.findMany({ orderBy: { label: "asc" } });
  if (rows.length === 0) {
    await db.skill
      .createMany({ data: SKILL_SEED })
      .catch(() => undefined); // idempotent: unique slug violations from concurrent seeds are fine
    rows = await db.skill.findMany({ orderBy: { label: "asc" } });
  }
  return ok({ skills: rows.map((r) => ({ slug: r.slug, label: r.label })) });
});
