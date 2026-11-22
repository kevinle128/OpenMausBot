import { useState } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

type Field =
  | { kind: "number"; name: string; integer: boolean; min?: number; max?: number; fallback?: number }
  | { kind: "string"; name: string; fallback?: string }
  | { kind: "boolean"; name: string; fallback?: boolean }
  | { kind: "enum"; name: string; options: string[]; fallback?: string }
  | { kind: "other"; name: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** One field per property of the connector's settings schema (JSON Schema). A shape the form cannot edit becomes a read-only field. */
export function fieldsOf(schema: Record<string, unknown>): Field[] {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return Object.entries(properties).map(([name, raw]): Field => {
    const spec = isRecord(raw) ? raw : {};
    const number = (value: unknown) => (typeof value === "number" ? value : undefined);
    const withDefault = <T,>(fallback: T | undefined) => (fallback === undefined ? {} : { fallback });
    if (Array.isArray(spec.enum) && spec.enum.length > 0 && spec.enum.every((item) => typeof item === "string")) {
      return { kind: "enum", name, options: spec.enum as string[], ...withDefault(typeof spec.default === "string" ? spec.default : undefined) };
    }
    if (spec.type === "integer" || spec.type === "number") {
      return {
        kind: "number", name, integer: spec.type === "integer",
        ...(number(spec.minimum) !== undefined ? { min: number(spec.minimum) } : {}),
        ...(number(spec.maximum) !== undefined ? { max: number(spec.maximum) } : {}),
        ...withDefault(number(spec.default)),
      };
    }
    if (spec.type === "string") return { kind: "string", name, ...withDefault(typeof spec.default === "string" ? spec.default : undefined) };
    if (spec.type === "boolean") return { kind: "boolean", name, ...withDefault(typeof spec.default === "boolean" ? spec.default : undefined) };
    return { kind: "other", name };
  });
}

const initial = (field: Field, settings: Record<string, unknown>): string | boolean => {
  const value = settings[field.name] ?? ("fallback" in field ? field.fallback : undefined);
  if (field.kind === "boolean") return value === true;
  return value === undefined || value === null ? "" : String(value);
};

/** The value to save for a field, or `undefined` when the text is not valid for it. */
function parsed(field: Field, value: string | boolean): unknown {
  if (field.kind === "boolean") return value;
  if (field.kind !== "number") return value;
  const text = String(value).trim();
  if (text === "") return undefined;
  const number = Number(text);
  if (!Number.isFinite(number) || (field.integer && !Number.isInteger(number))) return undefined;
  if ((field.min !== undefined && number < field.min) || (field.max !== undefined && number > field.max)) return undefined;
  return number;
}

/** "toleranceSeconds" reads "Tolerance seconds". */
const labelOf = (name: string) => {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toLocaleUpperCase() + words.slice(1);
};

const INPUT = "w-40 rounded-lg bg-control px-2.5 py-1.5 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50";

/** The settings of one connector, generated from its schema. Saving sends the whole settings object; the server checks it with the connector's own schema. */
export function ConnectorSettingsForm({ schema, settings, onSave }: {
  schema: Record<string, unknown>;
  settings: Record<string, unknown>;
  onSave: (settings: Record<string, unknown>) => Promise<void>;
}) {
  const fields = fieldsOf(schema);
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(fields.filter((field) => field.kind !== "other").map((field) => [field.name, initial(field, settings)])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (fields.length === 0) return <p className="text-[13px] text-ink-secondary">{t("eventSources.settings.none")}</p>;

  const editable = fields.filter((field) => field.kind !== "other");
  const next: Record<string, unknown> = { ...settings };
  let valid = true;
  for (const field of editable) {
    const value = parsed(field, values[field.name] ?? "");
    if (value === undefined) {
      valid = false;
      if (field.kind !== "number") delete next[field.name];
    } else next[field.name] = value;
  }
  const changed = JSON.stringify(next) !== JSON.stringify(settings);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };
  const set = (name: string, value: string | boolean) => setValues((current) => ({ ...current, [name]: value }));

  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (valid && changed && !saving) void save(); }}>
      {fields.map((field) => {
        const label = labelOf(field.name);
        const limits = field.kind === "number" && (field.min !== undefined || field.max !== undefined)
          ? t("eventSources.settings.range", { min: field.min ?? "…", max: field.max ?? "…" })
          : null;
        if (field.kind === "other") {
          return (
            <div key={field.name} data-settings-readonly={field.name} className="flex flex-col gap-1">
              <span className="text-[13px] font-medium text-ink">{label}</span>
              <pre className="overflow-x-auto rounded-lg bg-control px-2.5 py-1.5 font-mono text-[12px] text-ink-secondary">{JSON.stringify(settings[field.name] ?? null, null, 2)}</pre>
              <span className="text-[12px] text-ink-tertiary">{t("eventSources.settings.configFile")}</span>
            </div>
          );
        }
        const id = `event-setting-${field.name}`;
        return (
          <label key={field.name} htmlFor={id} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] font-medium text-ink">{label}{limits && <span className="ms-2 text-[12px] font-normal text-ink-tertiary">{limits}</span>}</span>
            {field.kind === "boolean" ? (
              <input id={id} type="checkbox" disabled={saving} checked={values[field.name] === true} onChange={(event) => set(field.name, event.target.checked)} />
            ) : field.kind === "enum" ? (
              <select id={id} disabled={saving} className={INPUT} value={String(values[field.name] ?? "")} onChange={(event) => set(field.name, event.target.value)}>
                {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            ) : (
              <input
                id={id}
                disabled={saving}
                className={cn(INPUT, parsed(field, values[field.name] ?? "") === undefined && "ring-2 ring-danger")}
                type={field.kind === "number" ? "number" : "text"}
                {...(field.kind === "number" ? { min: field.min, max: field.max, step: field.integer ? 1 : "any" } : {})}
                value={String(values[field.name] ?? "")}
                onChange={(event) => set(field.name, event.target.value)}
              />
            )}
          </label>
        );
      })}
      {error && <p role="alert" className="rounded-lg bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger">{error}</p>}
      {editable.length > 0 && (
        <div>
          <button type="submit" disabled={!valid || !changed || saving} className="rounded-full bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white transition-colors enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40">
            {saving ? t("eventSources.settings.saving") : t("eventSources.settings.save")}
          </button>
        </div>
      )}
    </form>
  );
}
