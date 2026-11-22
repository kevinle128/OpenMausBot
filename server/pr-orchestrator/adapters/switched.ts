import type { CommandContext, OrchestratorPorts } from "../handlers.ts";
import {
  PortUnavailableError, type AgentRuntimePort, type ForgePort, type NotifierPort, type OwnerResolver,
} from "../ports.ts";
import type { OrchestratorConfig, Provider } from "../types.ts";
import { stubPorts } from "./stub.ts";

/** The adapters that the host built. A port with no entry here has no real adapter. */
export interface AttachedAdapters {
  forge: Partial<Record<Provider, ForgePort>>;
  notifier: NotifierPort | null;
  runtime: AgentRuntimePort | null;
  resolvers: OwnerResolver[];
}

export const noneAttached = (): AttachedAdapters => ({ forge: {}, notifier: null, runtime: null, resolvers: [] });

const FORGE_NAMES: Record<Provider, string> = { github: "GitHub", gitlab: "GitLab" };

/**
 * Ports that read the live config on every call. A switch that is off gives the stub. A switch that is on with nothing
 * attached throws PortUnavailableError, which the command bus turns into a waiting command, never a final skip.
 */
export function switchedPorts(config: () => OrchestratorConfig, attached: () => AttachedAdapters): OrchestratorPorts & { installed: CommandContext["installed"] } {
  const stubs = stubPorts();
  const switches = () => config().adapters;

  const forge = (provider: Provider): ForgePort => {
    const pick = (): ForgePort => {
      if (!switches().forge[provider].enabled) return stubs.forge[provider];
      const real = attached().forge[provider];
      if (!real) throw new PortUnavailableError(`the ${FORGE_NAMES[provider]} adapter is not attached yet`);
      return real;
    };
    return {
      provider,
      details: pr => pick().details(pr),
      ciLog: (pr, job, opts) => pick().ciLog(pr, job, opts),
      reviewItems: (pr, commentId) => pick().reviewItems(pr, commentId),
      merge: (pr, opts) => pick().merge(pr, opts),
      comment: (pr, text) => pick().comment(pr, text),
    };
  };

  const pickRuntime = (): AgentRuntimePort => {
    if (!switches().runtime.enabled) return stubs.runtime;
    const real = attached().runtime;
    if (!real) throw new PortUnavailableError("the agent runtime adapter is not attached yet");
    return real;
  };
  const runtime: AgentRuntimePort = {
    get runtime() { return attached().runtime?.runtime ?? stubs.runtime.runtime; },
    watchCreations(report) {
      // The subscription outlives switch changes: a report is dropped while binding is off, and used again once it is on.
      const unwatch = attached().runtime?.watchCreations(created => {
        const { enabled, bindOwners } = switches().runtime;
        if (enabled && bindOwners) report(created);
      });
      return () => unwatch?.();
    },
    send: (owner, message, opts) => pickRuntime().send(owner, message, opts),
    isAlive: owner => pickRuntime().isAlive(owner),
    spawn: req => pickRuntime().spawn(req),
    label: (owner, key, value) => pickRuntime().label(owner, key, value),
  };

  const pickNotifier = (): NotifierPort => {
    if (!switches().notifier.enabled) return stubs.notifier;
    const real = attached().notifier;
    if (!real) throw new PortUnavailableError("the notifier adapter is not attached yet");
    return real;
  };
  const live = (): NotifierPort | null => (switches().notifier.enabled ? attached().notifier : null);
  const notifier: NotifierPort = {
    card: (kind, payload, answers) => pickNotifier().card(kind, payload, answers),
    notice: (kind, text, subject) => pickNotifier().notice(kind, text, subject),
    adopt: (cardId, card) => live()?.adopt?.(cardId, card) ?? false,
    reconcile: openDecisionIds => { live()?.reconcile?.(openDecisionIds); },
  };

  return {
    forge: { github: forge("github"), gitlab: forge("gitlab") },
    runtime,
    notifier,
    workflows: stubs.workflows,
    get resolvers() { return switches().runtime.enabled ? attached().resolvers : []; },
    interpreters: stubs.interpreters,
    installed: {
      forge: provider => switches().forge[provider].enabled,
      get notifier() { return switches().notifier.enabled; },
      get runtime() { return switches().runtime.enabled; },
    },
  };
}
