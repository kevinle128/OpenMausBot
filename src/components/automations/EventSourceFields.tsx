// Event types, repos (Tag Picker) and authors for a pull request event app.
import type { LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import { ResourceTagPicker } from "./ResourceTagPicker";

const FIELD = "w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent/70";
const LABEL = "mb-1.5 block text-[12px] font-medium text-ink-secondary";

/** Pull request event types, in the order the server offers them. */
export const PR_EVENT_TYPES = [
  "pr.opened",
  "pr.pushed",
  "pr.ci.finished",
  "pr.review.finished",
  "pr.comment.created",
  "pr.conflict.detected",
  "pr.merged",
  "pr.closed",
] as const;

const TYPE_LABEL: Record<string, LocaleKey> = {
  "pr.opened": "automations.editor.eventSource.type.opened",
  "pr.pushed": "automations.editor.eventSource.type.pushed",
  "pr.ci.finished": "automations.editor.eventSource.type.ciFinished",
  "pr.review.finished": "automations.editor.eventSource.type.reviewFinished",
  "pr.comment.created": "automations.editor.eventSource.type.comment",
  "pr.conflict.detected": "automations.editor.eventSource.type.conflict",
  "pr.merged": "automations.editor.eventSource.type.merged",
  "pr.closed": "automations.editor.eventSource.type.closed",
};

export function eventTypeLabel(type: string): string {
  const key = TYPE_LABEL[type];
  return key ? t(key) : type;
}

/** Comma-separated and line-separated text, or a saved list, as distinct entries. */
export function settingList(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.flatMap((item) => typeof item === "string" ? settingList(item) : []))];
  if (typeof value !== "string") return [];
  return [...new Set(value.split(/[\n,]/).map((part) => part.trim()).filter(Boolean))];
}

export function EventSourceFields({
  app, options, types, repos, authors, gitlab, onTypes, onRepos, onAuthors,
}: {
  app?: string;
  options: readonly string[];
  types: readonly string[];
  repos: string;
  authors: string;
  gitlab: boolean;
  onTypes: (types: string[]) => void;
  onRepos: (repos: string) => void;
  onAuthors: (authors: string) => void;
}) {
  const chosen = new Set(types);
  const selectedRepos = settingList(repos);
  const toggle = (type: string, on: boolean) => {
    const next = new Set(types);
    if (on) next.add(type);
    else next.delete(type);
    onTypes(options.filter((option) => next.has(option)));
  };
  return (
    <>
      <fieldset className="sm:col-span-2">
        <legend className={LABEL}>{t("automations.editor.eventSource.types")}</legend>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {options.map((type) => (
            <label key={type} className="flex items-center gap-2 text-[13px] text-ink">
              <input type="checkbox" value={type} checked={chosen.has(type)} onChange={(input) => toggle(type, input.target.checked)} />
              <span>{eventTypeLabel(type)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="block sm:col-span-2">
        <span className={LABEL}>{t("automations.editor.eventSource.repos")}</span>
        <ResourceTagPicker
          app={app ?? (gitlab ? "gitlab" : "github")}
          kind="repositories"
          values={selectedRepos}
          onChange={(next) => onRepos(next.join("\n"))}
          placeholder={t("automations.editor.eventSource.reposPlaceholder")}
          emptyHint={gitlab ? t("automations.editor.eventSource.reposExample.gitlab") : t("automations.editor.eventSource.reposExample.github")}
          ariaLabel={t("automations.editor.eventSource.repos")}
        />
        <span className="mt-1.5 block text-[12px] text-ink-secondary">{gitlab ? t("automations.editor.eventSource.reposExample.gitlab") : t("automations.editor.eventSource.reposExample.github")}</span>
      </div>
      <label className="block sm:col-span-2">
        <span className={LABEL}>{t("automations.editor.eventSource.authors")}</span>
        <input value={authors} onChange={(input) => onAuthors(input.target.value)} placeholder={t("automations.editor.eventSource.authorsPlaceholder")} className={FIELD} />
      </label>
    </>
  );
}
