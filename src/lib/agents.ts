import { stepCountIs, ToolLoopAgent, tool, type ToolSet } from "ai";
import { z } from "zod";
import { models } from "../env";

export type AgentStatusEvent =
  | {
      type: "delegate-start";
      agent: string;
      task: string;
    }
  | {
      type: "delegate-finish";
      agent: string;
      summary: string;
    }
  | {
      type: "step-finish";
      agent: string;
      text: string;
    }
  | {
      type: "tool-start";
      agent: string;
      toolName: string;
      toolCallId: string;
      input: unknown;
    }
  | {
      type: "tool-finish";
      agent: string;
      toolName: string;
      toolCallId: string;
      output?: unknown;
      error?: unknown;
      success: boolean;
    };

type BuildMainAgentOptions = {
  googleTools: ToolSet;
  directTools: ToolSet;
  emitStatus: (event: AgentStatusEvent) => void;
};

function createAgentCallbacks(
  agentName: string,
  emitStatus: (event: AgentStatusEvent) => void,
) {
  return {
    experimental_onToolCallStart: ({ toolCall }: { toolCall: { toolName: string; toolCallId: string; input: unknown } }) => {
      emitStatus({
        type: "tool-start",
        agent: agentName,
        toolName: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
        input: toolCall.input,
      });
    },
    experimental_onToolCallFinish: ({ toolCall, success, output, error }: { toolCall: { toolName: string; toolCallId: string }; success: boolean; output?: unknown; error?: unknown }) => {
      emitStatus({
        type: "tool-finish",
        agent: agentName,
        toolName: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
        success,
        output,
        error,
      });
    },
    onStepFinish: ({ text }: { text?: string }) => {
      if (text?.trim()) {
        emitStatus({
          type: "step-finish",
          agent: agentName,
          text: text.trim(),
        });
      }
    },
  };
}

function createResearchAgent(
  directTools: ToolSet,
  emitStatus: (event: AgentStatusEvent) => void,
) {
  return new ToolLoopAgent({
    model: models.worker,
    instructions: `You are a research subagent. Focus on finding facts, organizing evidence, and returning concise notes the main agent can reuse.
Use the direct tools when time, weather, or local task context would help.
If a required tool is unavailable, say what information is missing instead of guessing.`,
    stopWhen: stepCountIs(4),
    tools: directTools,
    ...createAgentCallbacks("research", emitStatus),
  });
}

function createOperationsAgent(
  directTools: ToolSet,
  emitStatus: (event: AgentStatusEvent) => void,
) {
  return new ToolLoopAgent({
    model: models.worker,
    instructions: `You are an operations subagent. Turn rough requests into action plans, execution checklists, and follow-up items.
Use the local task tools whenever a plan should become tracked work.
Keep the output practical and short.`,
    stopWhen: stepCountIs(4),
    tools: directTools,
    ...createAgentCallbacks("operations", emitStatus),
  });
}

function createTaskManagerAgent(
  directTools: ToolSet,
  emitStatus: (event: AgentStatusEvent) => void,
) {
  return new ToolLoopAgent({
    model: models.worker,
    instructions: `You are a task manager subagent. Your job is to inspect, create, update, and tidy the local task list for the subagents playground.
Prefer using task tools instead of only describing what should happen.
When the request is ambiguous, inspect the current tasks first and act conservatively.`,
    stopWhen: stepCountIs(5),
    tools: directTools,
    ...createAgentCallbacks("task manager", emitStatus),
  });
}

function createDailyBriefAgent(
  directTools: ToolSet,
  emitStatus: (event: AgentStatusEvent) => void,
) {
  return new ToolLoopAgent({
    model: models.worker,
    instructions: `You are a daily brief subagent. Build compact day-planning briefs using current time, optional weather, and the local task list.
Use tools directly when they can improve the brief. Keep the output crisp and action-oriented.`,
    stopWhen: stepCountIs(5),
    tools: directTools,
    ...createAgentCallbacks("daily brief", emitStatus),
  });
}

export function buildMainAgent({
  googleTools,
  directTools,
  emitStatus,
}: BuildMainAgentOptions) {
  const researchAgent = createResearchAgent(directTools, emitStatus);
  const operationsAgent = createOperationsAgent(directTools, emitStatus);
  const taskManagerAgent = createTaskManagerAgent(directTools, emitStatus);
  const dailyBriefAgent = createDailyBriefAgent(directTools, emitStatus);

  return new ToolLoopAgent({
    model: models.main,
    instructions: `You are the main terminal orchestrator for a subagent playground.
You can:
- answer directly when the request is simple
- delegate research-heavy work to the research subagent
- delegate planning/execution work to the operations subagent
- delegate task-board changes to the task manager subagent
- delegate "plan my day" style requests to the daily brief subagent
- use direct tools for local time, weather, and task management
- use Google Workspace MCP tools whenever Gmail, Drive, Calendar, Docs, or file lookup would help

When the user asks about connected Google data, prefer MCP tools over guessing.
If Google tools are not connected, explain that the user should run /auth first.
Prefer direct tools over Google MCP when the request is purely local.
Be concise and explicit about when you delegated work.`,
    providerOptions: {
      openrouter: {
        reasoning: {
          effort: "medium",
        },
      },
    },
    stopWhen: stepCountIs(8),
    tools: {
      delegateResearch: tool({
        description:
          "Ask the research subagent to investigate a question and return a tight evidence-oriented summary.",
        inputSchema: z.object({
          task: z.string().min(1),
        }),
        execute: async ({ task }, { abortSignal }) => {
          emitStatus({
            type: "delegate-start",
            agent: "research",
            task,
          });
          const result = await researchAgent.generate({
            prompt: task,
            abortSignal,
          });
          emitStatus({
            type: "delegate-finish",
            agent: "research",
            summary: result.text,
          });
          return result.text;
        },
      }),
      delegateOperations: tool({
        description:
          "Ask the operations subagent to turn a request into a checklist, next steps, or execution plan.",
        inputSchema: z.object({
          task: z.string().min(1),
        }),
        execute: async ({ task }, { abortSignal }) => {
          emitStatus({
            type: "delegate-start",
            agent: "operations",
            task,
          });
          const result = await operationsAgent.generate({
            prompt: task,
            abortSignal,
          });
          emitStatus({
            type: "delegate-finish",
            agent: "operations",
            summary: result.text,
          });
          return result.text;
        },
      }),
      delegateTaskManager: tool({
        description:
          "Ask the task manager subagent to inspect or modify the local task list.",
        inputSchema: z.object({
          task: z.string().min(1),
        }),
        execute: async ({ task }, { abortSignal }) => {
          emitStatus({
            type: "delegate-start",
            agent: "task manager",
            task,
          });
          const result = await taskManagerAgent.generate({
            prompt: task,
            abortSignal,
          });
          emitStatus({
            type: "delegate-finish",
            agent: "task manager",
            summary: result.text,
          });
          return result.text;
        },
      }),
      delegateDailyBrief: tool({
        description:
          "Ask the daily brief subagent to prepare a day plan using time, weather, and local tasks.",
        inputSchema: z.object({
          task: z.string().min(1),
        }),
        execute: async ({ task }, { abortSignal }) => {
          emitStatus({
            type: "delegate-start",
            agent: "daily brief",
            task,
          });
          const result = await dailyBriefAgent.generate({
            prompt: task,
            abortSignal,
          });
          emitStatus({
            type: "delegate-finish",
            agent: "daily brief",
            summary: result.text,
          });
          return result.text;
        },
      }),
      ...directTools,
      ...googleTools,
    },
  });
}
