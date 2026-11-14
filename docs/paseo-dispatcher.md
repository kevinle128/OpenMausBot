# Paseo Dispatcher

The Dispatcher is a bot that takes a large task, splits it, runs each piece as a
Paseo coding agent, follows the agents and reports one result. It needs the
Paseo bridge (`OMB_PASEO_BRIDGE=1`) so it is woken when an agent finishes or
fails. Permission requests from its agents go through the same gatekeeper as
every other Paseo agent; the Dispatcher never answers them.

## Set it up (once)

1. **Add the preset.** In **Templates → Import**, choose
   `docs/presets/paseo-dispatcher.json`, then pick **Paseo Dispatcher** under
   **Starting role** when you add a bot. A preset from a file brings its skill
   switched off: open the new bot's Skills and switch on **paseo-dispatch**
   after reading it.
2. **Add the Paseo MCP server by hand.** A preset cannot carry an MCP server,
   and a Paseo server lets a bot start agents that run commands on this
   computer, so OpenMausBot does not add it for you. Open **Plugins → MCP
   servers → Add server** and paste:
   - URL: `http://127.0.0.1:6767/mcp/agents` (the daemon's own port; use the
     host and port of `OMB_PASEO_URL` if you changed it).
   - With a daemon password, one header: `Authorization` with the value
     `Bearer <the daemon password>`. The local credential file is not accepted
     on this endpoint.
   Wait for *Connected*, then under **Bot access** let only the Dispatcher use
   it.
3. Keep `OMB_PASEO_BRIDGE=1` set for OpenMausBot.

## How it works

- The bot learns its own thread id from `list_threads`: the row for the
  conversation it speaks in is marked `yours, this conversation`.
- It creates every agent with the label `omb-dispatcher-thread=<thread id>`.
- When a labelled agent finishes or fails, the bridge starts a run of the
  Dispatcher in that thread with the agent id, title, status, reason and a
  short, secret-scrubbed summary of the agent's last message. If the
  Dispatcher is busy, the run waits for its turn. Agents without the label
  wake nobody.
- The number of agents is not limited. The Dispatcher says how many it
  started; watch the computer's load while it works.

Source: `server/paseo/dispatcher-wake.ts`.
