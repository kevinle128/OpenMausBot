import type { ForgePort } from "../ports.ts";
import type { Provider } from "../types.ts";
import type { AdapterContext } from "./build.ts";

/** The forge adapters that this install has. None yet: a switched-on forge waits until one is attached. */
export function forgeAdapters(_ctx: AdapterContext): Partial<Record<Provider, ForgePort>> {
  return {};
}
