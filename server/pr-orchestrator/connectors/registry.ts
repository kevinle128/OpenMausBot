import type { ConnectorDefinition } from "../ports.ts";
import { CONTRACT_EVENT_TYPES, payloadSchemaOf } from "../contract/omb-event.v1.ts";

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface ContractView {
  types: Record<string, { subjectKind: string; title: string; description: string }>;
  payloadSchemaOf(type: string): Record<string, unknown> | null;
}

export interface ConnectorEventType {
  type: string;
  title: string;
  description: string;
  subjectKind: string;
  payloadSchema: Record<string, unknown>;
}

export interface ConnectorRegistry {
  list(): readonly ConnectorDefinition[];
  get(definitionId: string): ConnectorDefinition | undefined;
  /** The declared types of one definition, or of all of them, each with its contract title, description and payload schema. */
  eventTypes(definitionId?: string): ConnectorEventType[];
}

const SHIPPED_CONTRACT: ContractView = { types: CONTRACT_EVENT_TYPES, payloadSchemaOf };

export function createConnectorRegistry(definitions: readonly ConnectorDefinition[], contract: ContractView = SHIPPED_CONTRACT): ConnectorRegistry {
  const byId = new Map<string, ConnectorDefinition>();
  for (const definition of definitions) {
    if (!KEBAB.test(definition.id)) throw new Error(`connector id ${definition.id} is not kebab-case`);
    if (byId.has(definition.id)) throw new Error(`duplicate connector id ${definition.id}`);
    for (const type of definition.emits) {
      if (!Object.hasOwn(contract.types, type)) throw new Error(`connector ${definition.id} emits ${type}, which the contract does not define`);
    }
    if (definition.delivery === "inbound-http" && !definition.inbound) throw new Error(`connector ${definition.id} is inbound-http and needs an inbound handler`);
    if ((definition.delivery === "subscription" || definition.delivery === "poll") && !definition.subscribe) {
      throw new Error(`connector ${definition.id} is ${definition.delivery} and needs a subscribe function`);
    }
    byId.set(definition.id, definition);
  }
  const all = [...byId.values()];

  function typesOf(definition: ConnectorDefinition): ConnectorEventType[] {
    return definition.emits.map(type => {
      const entry = contract.types[type]!;
      return { type, title: entry.title, description: entry.description, subjectKind: entry.subjectKind, payloadSchema: contract.payloadSchemaOf(type) ?? {} };
    });
  }

  return {
    list: () => all,
    get: id => byId.get(id),
    eventTypes: id => (id === undefined ? all : [byId.get(id)].filter(d => d !== undefined)).flatMap(typesOf),
  };
}
