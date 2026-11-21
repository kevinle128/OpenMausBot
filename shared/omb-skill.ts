/** One agent harness as `omb skill list` and `omb skill install` report it (bin/omb.mjs). */
export type SkillStatus = "installed" | "outdated" | "missing" | "unsupported" | "refused" | "updated" | "unchanged" | "skipped" | "failed";

export interface SkillRow {
  harness: string;
  label: string;
  folder: string | null;
  status: SkillStatus;
  /** True when omb can name this agent today; otherwise the skill installs but `omb secrets` calls that need an agent are refused. */
  recognised: boolean;
  note?: string;
}

export interface SkillInstallResult {
  rows: SkillRow[];
  /** The path of the omb command this install left on the computer. */
  command?: string;
  /** This computer is not paired with the server yet and no code was given; nothing was installed. */
  needsPairing?: true;
  /** `pairedElsewhere`: this computer is paired with another server and that pairing stays. `pairNeeded`: the app is connected to this server, cannot pair this computer itself, and this computer is not paired. */
  notes?: Array<{ key: "pairedElsewhere" | "pairNeeded"; server: string }>;
  error?: string;
}

/** What the desktop app says about this computer: `available` is false on Windows and where the app has no server address. */
export interface SkillState {
  available: boolean;
  paired: boolean;
  rows: SkillRow[];
}
