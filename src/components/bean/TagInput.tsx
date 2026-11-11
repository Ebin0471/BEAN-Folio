"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Free-form chip input for tools, skill labels, etc. Enter/comma adds, Backspace removes. */
export function TagInput({
  value,
  onChange,
  placeholder,
  max = 12,
  className,
  ariaLabel,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  max?: number;
  className?: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState("");

  function add(raw: string) {
    const t = raw.trim().replace(/,+$/, "").slice(0, 40);
    if (!t) return;
    if (value.some((v) => v.toLowerCase() === t.toLowerCase())) {
      setDraft("");
      return;
    }
    if (value.length >= max) return;
    onChange([...value, t]);
    setDraft("");
  }

  return (
    <div
      className={cn(
        "flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
        className
      )}
    >
      {value.map((tag) => (
        <Badge key={tag} variant="secondary" className="gap-1 rounded-full pr-1 font-normal">
          {tag}
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            className="rounded-full p-0.5 hover:bg-foreground/10"
            onClick={() => onChange(value.filter((v) => v !== tag))}
          >
            <X className="size-3" aria-hidden />
          </button>
        </Badge>
      ))}
      <Input
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          if (v.endsWith(",")) add(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => draft && add(draft)}
        placeholder={value.length >= max ? `Max ${max}` : placeholder}
        disabled={value.length >= max}
        aria-label={ariaLabel ?? "Add tag"}
        className="h-7 min-w-24 flex-1 border-0 bg-transparent p-0.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
    </div>
  );
}
