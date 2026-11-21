// While the app is connected to another server, `serverOrigin()` is null and `remoteServer()` is that server: the skill still
// installs here, but the address of that connection is a companion sidecar that answers only the phone routes, so the app
// cannot pair this computer and says what the person does instead.
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyOmb, findNode, loadOmb, ombInstallPath, runOmb } from "./omb-install.mjs";
import { commandPath } from "./shell-path.mjs";

const HARNESS_ID = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const PAIRING_CODE = /^[A-Za-z0-9-]{4,64}$/;
const MAX_HARNESSES = 40;

const checkedIds = (value) => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_HARNESSES || !value.every((id) => typeof id === "string" && HARNESS_ID.test(id))) {
    throw new Error("Choose at least one agent harness");
  }
  return [...new Set(value)];
};

/** `guard` is the local-page guard of the IPC channel. omb runs in this process, so a pairing code is on no command line. */
export function installOmbSkill({ ipcMain, guard, serverOrigin, remoteServer = () => null, isPackaged, resourcesPath, platform = process.platform, home = homedir(), env = process.env, load = loadOmb, searchPath = commandPath }) {
  const source = isPackaged ? path.join(resourcesPath, "server", "bin", "omb.mjs") : fileURLToPath(new URL("../bin/omb.mjs", import.meta.url));
  const available = platform === "darwin" || platform === "linux";
  const origin = () => { try { return new URL(serverOrigin() ?? "").origin; } catch { return null; } };
  const remote = () => { try { return new URL(remoteServer() ?? "").origin; } catch { return null; } };
  const anyPairing = async () => (await run(["status"])).data?.tokenAccepted === true;
  const ombEnv = async () => ({ ...env, PATH: await searchPath({ platform, env, home }) });
  const run = async (argv, extra = {}) => {
    const shellEnv = await ombEnv();
    return runOmb(await load(source), argv, { env: shellEnv, home, nodePath: findNode(shellEnv.PATH).path, selfPath: ombInstallPath(home), ...extra });
  };
  const loopback = (address) => { try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(address).hostname); } catch { return false; } };
  const pairing = async (server) => {
    const { data } = await run(["status"]);
    const paired = data?.tokenAccepted === true && data.server === server;
    const elsewhere = typeof data?.server === "string" && data.server !== server && !(loopback(data.server) && loopback(server)) ? data.server : null;
    return { paired, elsewhere };
  };

  ipcMain.handle("omb-skill:state", guard("omb-skill:state", async () => {
    const server = origin();
    const other = remote();
    if (!available || (!server && !other)) return { available: false, paired: false, rows: [] };
    if (other) {
      const [paired, list] = await Promise.all([anyPairing(), run(["skill", "list"])]);
      return { available: true, paired, rows: Array.isArray(list.data?.rows) ? list.data.rows : [] };
    }
    const [{ paired }, list] = await Promise.all([pairing(server), run(["skill", "list"])]);
    return { available: true, paired, rows: Array.isArray(list.data?.rows) ? list.data.rows : [] };
  }));

  ipcMain.handle("omb-skill:install", guard("omb-skill:install", async (_event, harnesses, code) => {
    const ids = checkedIds(harnesses);
    const server = origin();
    const other = remote();
    if (!available || (!server && !other)) throw new Error("Installing the skill from this app is not available on this computer");
    if (code !== undefined && (typeof code !== "string" || !PAIRING_CODE.test(code))) throw new Error("The pairing code is not valid");
    const notes = [];
    if (other) {
      if (!(await anyPairing())) notes.push({ key: "pairNeeded", server: other });
    } else {
    const { paired, elsewhere } = await pairing(server);
    if (elsewhere) notes.push({ key: "pairedElsewhere", server: elsewhere });
    if (!paired && !elsewhere) {
      if (code === undefined) return { needsPairing: true, rows: [], notes };
      const result = await run(["pair", code, "--server", server], { hide: [code] });
      if (result.code !== 0) return { rows: [], notes, error: result.error ?? "Pairing failed" };
    }
    }
    const copied = copyOmb({ source, home });
    const result = await run(["skill", "install", "--harness", ids.join(",")]);
    if (!Array.isArray(result.data?.rows)) return { rows: [], notes, error: result.error ?? "Installing the skill failed" };
    return { rows: result.data.rows, notes, command: copied.path, paired: true };
  }));
}
