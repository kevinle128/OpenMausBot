import { rpcCall, type RpcContext } from "./rpc.ts";
import { taskSchema } from "./schemas.ts";
import type { McpInputResponse, McpTask } from "./types.ts";

export type SdkRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export interface TaskLayer {
  callToolAsTask(name: string, args: Record<string, unknown>): Promise<{ task: McpTask } | { result: unknown }>;
  getTask(taskId: string): Promise<McpTask>;
  updateTask(taskId: string, inputResponses: Record<string, McpInputResponse>): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
}

export function createTaskLayer(request: SdkRequest, rpc: RpcContext): TaskLayer {
  return {
    async callToolAsTask(name, args) {
      const result = await rpcCall(rpc, "tools/call", { name, arguments: args });
      if (result.resultType !== "task") return { result };
      return { task: taskSchema.parse(result) };
    },
    async getTask(taskId) {
      return taskSchema.parse(await request("tasks/get", { taskId }));
    },
    async updateTask(taskId, inputResponses) {
      await request("tasks/update", { taskId, inputResponses });
    },
    async cancelTask(taskId) {
      await request("tasks/cancel", { taskId });
    },
  };
}
