import type { OrchestratorPorts } from "../handlers.ts";
import { NotInstalledError, type ForgePort } from "../ports.ts";
import type { Provider } from "../types.ts";

const absent = (port: string, method: string) => (): never => { throw new NotInstalledError(port, method); };
const noUnsubscribe = () => () => {};

function stubForge(provider: Provider): ForgePort {
  const port = `forge.${provider}`;
  return {
    provider,
    details: absent(port, "details"), ciLog: absent(port, "ciLog"), reviewItems: absent(port, "reviewItems"),
    merge: absent(port, "merge"), comment: absent(port, "comment"),
  };
}

/** Ports with no real adapter: every call throws NotInstalledError, except the watchers, which never report. */
export function stubPorts(): OrchestratorPorts {
  return {
    forge: { github: stubForge("github"), gitlab: stubForge("gitlab") },
    runtime: {
      runtime: "stub", watchCreations: noUnsubscribe, send: absent("runtime", "send"), isAlive: absent("runtime", "isAlive"),
      spawn: absent("runtime", "spawn"), label: absent("runtime", "label"),
    },
    notifier: { card: absent("notifier", "card"), notice: absent("notifier", "notice") },
    workflows: { start: absent("workflows", "start"), cancel: absent("workflows", "cancel"), watch: noUnsubscribe },
    resolvers: [],
    interpreters: [],
  };
}
