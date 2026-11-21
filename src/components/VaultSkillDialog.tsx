import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import type { SkillInstallResult, SkillRow } from "../../shared/omb-skill";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { desktopSkill, installOnServer, requestSecretsPairing, serverSkillRows } from "@/lib/omb-skill";
import { SettingsDialog } from "./settings/SettingsDialog";

// Security: a pairing code or link is held in memory only to hand to this computer's omb or to show once; it is never stored or logged.

const STATE_WORDS = {
  installed: "settings.vault.skill.state.installed", outdated: "settings.vault.skill.state.outdated", missing: "settings.vault.skill.state.missing",
  unsupported: "settings.vault.skill.state.unsupported", refused: "settings.vault.skill.state.refused",
} as const;
const RESULT_WORDS = {
  installed: "settings.vault.skill.result.installed", updated: "settings.vault.skill.result.updated", unchanged: "settings.vault.skill.result.unchanged",
  skipped: "settings.vault.skill.result.skipped", refused: "settings.vault.skill.result.refused", failed: "settings.vault.skill.result.failed",
} as const;

const message = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);
const selectable = (row: SkillRow) => row.status !== "unsupported";

export function VaultSkillDialog({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<SkillRow[] | null>(null);
  const [onThisComputer, setOnThisComputer] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, SkillRow> | null>(null);
  const [notes, setNotes] = useState<SkillInstallResult["notes"]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const desktop = desktopSkill();
        const state = desktop ? await desktop.state() : null;
        const here = state?.available === true;
        const list = here ? state.rows : await serverSkillRows();
        if (!live) return;
        setOnThisComputer(here);
        setRows(list);
      } catch (cause) {
        if (live) { setRows([]); setError(message(cause, t("settings.vault.skill.loadError"))); }
      }
    })();
    return () => { live = false; };
  }, []);

  const available = useMemo(() => (rows ?? []).filter(selectable), [rows]);
  const ids = available.filter((row) => chosen.has(row.harness)).map((row) => row.harness);
  const allChosen = available.length > 0 && ids.length === available.length;
  const toggle = (id: string) => setChosen((now) => { const next = new Set(now); if (!next.delete(id)) next.add(id); return next; });

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      let result: SkillInstallResult;
      const desktop = onThisComputer ? desktopSkill() : undefined;
      if (desktop) {
        result = await desktop.install(ids);
        if (result.needsPairing) result = await desktop.install(ids, (await requestSecretsPairing()).code);
      } else result = await installOnServer(ids);
      if (result.error) setError(result.error);
      setNotes(result.notes ?? []);
      if (result.rows.length) setResults(new Map(result.rows.map((row) => [row.harness, row])));
    } catch (cause) { setError(message(cause, t("settings.vault.skill.installError"))); }
    finally { setBusy(false); }
  };

  const makeLink = async () => {
    setError(null);
    try { setLink((await requestSecretsPairing()).link); }
    catch (cause) { setError(message(cause, t("settings.vault.skill.pairError"))); }
  };
  const copy = async (key: string, text: string) => {
    if (await copyText(text) !== "empty") { setCopied(key); setTimeout(() => setCopied((now) => (now === key ? null : now)), 2000); }
  };
  const commands = [
    ...(link ? [["pair", t("settings.vault.skill.pairCommand"), `omb pair '${link}'`] as const] : []),
    ["install", t("settings.vault.skill.installCommand"), ids.length ? `omb skill install --harness ${ids.join(",")}` : "omb skill install --all"] as const,
  ];

  return (
    <SettingsDialog title={t("settings.vault.skill.title")} onClose={onClose}
      footer={<>
        <button type="button" className="ui-button" onClick={onClose}>{t("common.close")}</button>
        <button type="button" className="ui-button ui-button-primary gap-1.5" disabled={busy || rows === null || ids.length === 0} onClick={() => void install()}>
          {busy && <Loader2 size={13} className="animate-spin" />}{t(busy ? "settings.vault.skill.installing" : "settings.vault.skill.install")}
        </button>
      </>}>
      <div className="flex flex-col gap-3" data-skill-dialog>
        <p className="text-[13px] leading-[18px] text-ink-secondary">{t("settings.vault.skill.intro")}</p>
        {rows !== null && <p className="text-[12px] leading-4 text-ink-tertiary" data-skill-where={onThisComputer ? "computer" : "server"}>{t(onThisComputer ? "settings.vault.skill.computer" : "settings.vault.skill.server")}</p>}
        {rows === null && <p role="status" className="text-[13px] text-ink-secondary">{t("settings.vault.skill.loading")}</p>}
        {rows !== null && rows.length > 0 && (
          <>
            <label className="flex items-center gap-2 text-[13px] text-ink">
              <input type="checkbox" name="selectAll" checked={allChosen} disabled={busy}
                onChange={() => setChosen(allChosen ? new Set() : new Set(available.map((row) => row.harness)))} />
              {t("settings.vault.skill.selectAll")}
            </label>
            <ul className="max-h-[320px] divide-y-[0.5px] divide-(--settings-edge) overflow-y-auto" data-skill-rows>
              {rows.map((row) => {
                const done = results?.get(row.harness);
                const note = done?.note ?? (row.status === "unsupported" ? row.note ?? t("settings.vault.skill.unsupportedReason") : !row.recognised ? t("settings.vault.skill.notRecognised") : row.note);
                return (
                  <li key={row.harness} data-skill-row={row.harness} className="py-2">
                    <label className={`flex items-start gap-2 ${selectable(row) ? "" : "opacity-60"}`}>
                      <input type="checkbox" name={row.harness} className="mt-[3px]" checked={chosen.has(row.harness)} disabled={busy || !selectable(row)} onChange={() => toggle(row.harness)} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-[13px] font-medium text-ink">{row.label}</span>
                          <span className="shrink-0 text-[12px] text-ink-secondary" data-skill-state>{done ? t(RESULT_WORDS[done.status as keyof typeof RESULT_WORDS] ?? STATE_WORDS.refused) : t(STATE_WORDS[row.status as keyof typeof STATE_WORDS] ?? STATE_WORDS.unsupported)}</span>
                        </span>
                        {row.folder && <span dir="ltr" className="block truncate text-[12px] text-ink-tertiary" title={row.folder}>{row.folder}</span>}
                        {note && <span className="block text-[12px] leading-snug text-ink-tertiary">{note}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {notes?.map((note) => note.key === "pairNeeded"
          ? <p key={note.key} role="status" className="text-[12px] leading-4 text-warning" data-skill-pair-needed>{t("settings.vault.skill.pairNeeded", { server: note.server })}</p>
          : <p key={note.key} role="status" className="text-[12px] leading-4 text-warning">{t("settings.vault.skill.pairedElsewhere", { server: note.server })}</p>)}
        {error && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
        {rows !== null && !onThisComputer && (
          <section className="flex flex-col gap-2 border-t-[0.5px] border-(--settings-edge) pt-3" data-skill-others>
            <div className="text-[13px] font-medium text-ink">{t("settings.vault.skill.others")}</div>
            <p className="text-[12px] leading-4 text-ink-tertiary">{t("settings.vault.skill.othersLine")}</p>
            {!link && <button type="button" className="ui-button self-start" onClick={() => void makeLink()}>{t("settings.vault.skill.pairLink")}</button>}
            {commands.map(([key, label, command]) => (
              <div key={key} className="flex flex-col gap-1">
                <span className="text-[12px] text-ink-secondary">{label}</span>
                <div className="flex items-start gap-2">
                  <code dir="ltr" className="min-w-0 flex-1 break-all rounded-md bg-inset/60 px-2 py-1 text-[12px]" data-skill-command={key}>{command}</code>
                  <button type="button" className="ui-button shrink-0" onClick={() => void copy(key, command)}>{t(copied === key ? "settings.vault.skill.copied" : "settings.vault.skill.copy")}</button>
                </div>
              </div>
            ))}
          </section>
        )}
      </div>
    </SettingsDialog>
  );
}
