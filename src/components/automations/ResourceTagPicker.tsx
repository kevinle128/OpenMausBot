// Reusable searchable Tag Picker for app resources (GitHub repos, GitLab projects, etc.).
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { loadAppResources, type ResourceItem } from "@/lib/forge-apps";
import { t } from "@/lib/i18n";

const isGlob = (value: string) => /[*?[\]]/.test(value);

export function ResourceTagPicker({
  app,
  kind = "repositories",
  values,
  onChange,
  placeholder,
  emptyHint,
  ariaLabel,
}: {
  app: string;
  kind?: string;
  values: readonly string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  emptyHint: string;
  ariaLabel: string;
}) {
  const [items, setItems] = useState<ResourceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!app) { setItems([]); return; }
    let alive = true;
    setLoading(true);
    loadAppResources(app, kind)
      .then((loaded) => { if (alive) setItems(loaded); })
      .catch(() => { if (alive) setItems([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [app, kind]);

  useEffect(() => {
    const onDocDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, []);

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = items.filter((item) => !q || item.id.toLowerCase().includes(q) || (item.meta?.toLowerCase().includes(q) ?? false));
    const exact = matched.some((item) => item.id.toLowerCase() === q) || values.some((v) => v.toLowerCase() === q);
    const custom: Array<ResourceItem & { custom?: boolean }> = q && !exact
      ? [{ id: query.trim(), label: query.trim(), meta: isGlob(query.trim()) ? t("resourcePicker.customGlob") : t("resourcePicker.addCustom"), group: "all", custom: true }]
      : [];
    return [...custom, ...matched];
  }, [items, query, values]);

  const safeHi = options.length ? Math.min(hi, options.length - 1) : 0;

  const toggle = (id: string) => {
    const trimmed = id.replace(/,/g, "").trim();
    if (!trimmed) return;
    if (values.includes(trimmed)) onChange(values.filter((v) => v !== trimmed));
    else onChange([...values, trimmed]);
    setQuery("");
    setHi(0);
    inputRef.current?.focus();
  };

  return (
    <div ref={rootRef} className="relative" data-resource-tag-picker={kind}>
      <div
        onClick={() => { setOpen(true); inputRef.current?.focus(); }}
        className={cn(
          "flex min-h-[44px] w-full flex-wrap items-center gap-1.5 rounded-xl border bg-panel px-2.5 py-1.5 transition-colors",
          open ? "border-accent/70 ring-1 ring-accent/25" : "border-hairline/60",
        )}
      >
        {values.map((val) => (
          <span
            key={val}
            data-resource-tag={val}
            className={cn(
              "inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-0.5 text-[12px] font-medium",
              isGlob(val)
                ? "border-accent/35 bg-accent/10 text-accent-text"
                : "border-hairline/60 bg-control text-ink",
            )}
          >
            <span className="truncate">{val}</span>
            <button
              type="button"
              aria-label={t("resourcePicker.remove", { value: val })}
              onClick={(event) => { event.stopPropagation(); onChange(values.filter((v) => v !== val)); }}
              className="rounded-full p-0.5 text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={query}
          aria-label={ariaLabel}
          autoComplete="off"
          spellCheck={false}
          placeholder={values.length ? t("resourcePicker.addAnother") : placeholder}
          onFocus={() => setOpen(true)}
          onChange={(event) => { setQuery(event.target.value); setHi(0); setOpen(true); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              if (!open) {
                setOpen(true);
                setHi(0);
              } else {
                setHi(options.length ? (safeHi + 1) % options.length : 0);
              }
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              if (!open) {
                setOpen(true);
                setHi(options.length ? options.length - 1 : 0);
              } else {
                setHi(options.length ? (safeHi - 1 + options.length) % options.length : 0);
              }
            } else if (event.key === "Enter" || event.key === ",") {
              const trimmed = query.trim();
              if (!open && !trimmed) return;
              event.preventDefault();
              const target = open ? (options[safeHi]?.id ?? trimmed) : trimmed;
              if (target) toggle(target);
            } else if (event.key === "Backspace" && !query && values.length) {
              onChange(values.slice(0, -1));
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
          className="h-7 min-w-[120px] flex-1 bg-transparent px-1 text-[13px] text-ink outline-none placeholder:text-ink-tertiary"
        />
        {loading && <Loader2 size={13} className="shrink-0 animate-spin text-ink-tertiary" />}
      </div>

      {open && (
        <div role="listbox" className="absolute inset-x-0 top-[calc(100%+6px)] z-30 max-h-60 overflow-y-auto rounded-xl border border-hairline/60 bg-panel p-1.5 shadow-xl">
          {options.length === 0 ? (
            <div className="px-2.5 py-2 text-[12px] text-ink-secondary">{emptyHint}</div>
          ) : (
            options.map((item, idx) => {
              const picked = values.includes(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={picked}
                  onMouseDown={(event) => { event.preventDefault(); toggle(item.id); }}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]",
                    idx === safeHi ? "bg-raised text-ink" : "text-ink hover:bg-raised/60",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="flex w-4 shrink-0 justify-center text-accent-text">
                      {picked ? <Check size={13} strokeWidth={2.5} /> : null}
                    </span>
                    <span className="truncate font-medium">
                      {"custom" in item && item.custom ? t("resourcePicker.addValue", { value: item.label }) : item.label}
                    </span>
                  </span>
                  {item.meta && <span className="shrink-0 text-[11px] text-ink-tertiary">{item.meta}</span>}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
