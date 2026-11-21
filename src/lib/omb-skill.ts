import type { SkillInstallResult, SkillRow } from "../../shared/omb-skill";
import { api } from "@/state/store";

const ROUTE = "/api/secrets/admin/skill-install";

/** The desktop app's bridge for this computer; absent in a browser, on an older app and on a remote server's page. */
export const desktopSkill = () => globalThis.window?.ogb?.ombSkill;

export const serverSkillRows = async (): Promise<SkillRow[]> => (await api<{ data: { rows: SkillRow[] } }>(ROUTE)).data.rows;

export const installOnServer = async (harnesses: string[]): Promise<SkillInstallResult> =>
  (await api<{ data: SkillInstallResult }>(ROUTE, { method: "POST", body: JSON.stringify({ harnesses }) })).data;

/** A pairing code that gives the computer that uses it the `secrets` scope only: the agent routes of the Vault, nothing else.
 * `link` is null when the server has no address another computer can reach (a loopback or public http page): then the
 * code goes with `--server` and the address the person uses. */
export async function requestSecretsPairing(): Promise<{ code: string; link: string | null }> {
  const offer = await api<{ code: string; url: string | null }>("/api/auth/pairing", { method: "POST", body: JSON.stringify({ scopes: ["secrets"] }) });
  return { code: offer.code, link: offer.url };
}
