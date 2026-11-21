// The skill installs on the computer where this window is open, whichever server or home page the main window shows.
// `allowed(event)` accepts the main window's own page and its verified saved-server and home pages, nothing else; the page
// sends harness ids only. While the window shows another server, this computer is not paired by the app: the dialog gets
// that server's own origin to show how to pair, because the companion address of a remote connection serves phone routes only.
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

/** omb runs in this process, so a pairing code is on no command line. `focused(event)`: the window is the one in use. */
export function installOmbSkill({ ipcMain, allowed, isLocal, focused = () => true, serverOrigin, remoteServer = () => null, isPackaged, resourcesPath, platform = process.platform, home = homedir(), env = process.env, load = loadOmb, searchPath = commandPath }) {
  const source = isPackaged ? path.join(resourcesPath, "server", "bin", "omb.mjs") : fileURLToPath(new URL("../bin/omb.mjs", import.meta.url));
  const available = platform === "darwin" || platform === "linux";
  const origin = () => { try { return new URL(serverOrigin() ?? "").origin; } catch { return null; } };
  const remote = () => { try { return new URL(remoteServer() ?? "").origin; } catch { return null; } };
  const guard = (channel, handler, { gesture = false } = {}) => (event, ...args) => {
    if (!allowed(event)) throw new Error(`${channel} is only available in the main window`);
    if (gesture && !focused(event)) throw new Error("Choose Install in the focused window");
    return handler(event, ...args);
  };
  const senderServer = (event) => { try { return new URL(event?.senderFrame?.url ?? "").origin; } catch { return null; } };
  // A remote page learns nothing about this computer's users: the home folder shows as `~` and the omb path stays here.
  const tilde = (value) => (typeof value === "string" ? value.split(home).join("~") : value);
  const shown = (event, rows) => (isLocal(event) ? rows : rows.map((row) => ({ ...row, folder: tilde(row.folder), note: tilde(row.note) })));
  const target = (event) => (isLocal(event) ? { server: origin(), other: remote() } : { server: null, other: senderServer(event) });
  ipcMain.on("omb-skill:page", (event) => { try { event.returnValue = allowed(event) === true; } catch { event.returnValue = false; } });
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

  ipcMain.handle("omb-skill:state", guard("omb-skill:state", async (event) => {
    const { server, other } = target(event);
    if (!available || (!server && !other)) return { available: false, paired: false, rows: [] };
    if (other) {
      const [paired, list] = await Promise.all([anyPairing(), run(["skill", "list"])]);
      return { available: true, paired, rows: shown(event, Array.isArray(list.data?.rows) ? list.data.rows : []) };
    }
    const [{ paired }, list] = await Promise.all([pairing(server), run(["skill", "list"])]);
    return { available: true, paired, rows: Array.isArray(list.data?.rows) ? list.data.rows : [] };
  }));

  ipcMain.handle("omb-skill:install", guard("omb-skill:install", async (event, harnesses, code) => {
    const ids = checkedIds(harnesses);
    const { server, other } = target(event);
    if (!available || (!server && !other)) throw new Error("Installing the skill from this app is not available on this computer");
    if (code !== undefined && (typeof code !== "string" || !PAIRING_CODE.test(code))) throw new Error("The pairing code is not valid");
    const known = (await load(source)).HARNESSES?.map((harness) => harness.id);
    if (!Array.isArray(known) || !ids.every((id) => known.includes(id))) throw new Error("Choose agent harnesses from the list");
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
    if (!isLocal(event)) return { rows: shown(event, result.data.rows), notes, paired: true };
    return { rows: result.data.rows, notes, command: copied.path, paired: true };
  }, { gesture: true }));
}
