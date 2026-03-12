import { stepCountIs, ToolLoopAgent, tool, type ToolSet } from "ai";
import { z } from "zod";
import { models } from "../env";

type BuildMainAgentOptions = {
  googleTools: ToolSet;
  emitStatus: (message: string) => void;
};

function createResearchAgent(emitStatus: (message: string) => void) {
  return new ToolLoopAgent({
    model: models.worker,
    instructions: `You are a research subagent. Focus on finding facts, organizing evidence, and returning concise notes the main agent can reuse. If tools are unavailable, say what information is missing instead of guessing.`,
    stopWhen: stepCountIs(4),
    onStepFinish: ({ text }) => {
      if (text?.trim()) {
        emitStatus("Research subagent finished a reasoning step.");
      }
    },
  });
}

function createOperationsAgent(emitStatus: (message: string) => void) {
  return new ToolLoopAgent({
    model: models.worker,
    instructions: `You are an operations subagent. Turn rough requests into action plans, execution checklists, and follow-up items. Keep the output practical and short.`,
    stopWhen: stepCountIs(4),
    onStepFinish: ({ text }) => {
      if (text?.trim()) {
        emitStatus("Operations subagent finished a reasoning step.");
      }
    },
  });
}

export function buildMainAgent({
  googleTools,
  emitStatus,
}: BuildMainAgentOptions) {
  const researchAgent = createResearchAgent(emitStatus);
  const operationsAgent = createOperationsAgent(emitStatus);

  return new ToolLoopAgent({
    model: models.main,
    instructions: `You are the main terminal orchestrator for a subagent playground.
You can:
- answer directly when the request is simple
- delegate research-heavy work to the research subagent
- delegate planning/execution work to the operations subagent
- use Google Workspace MCP tools whenever Gmail, Drive, Calendar, Docs, or file lookup would help

When the user asks about connected Google data, prefer MCP tools over guessing.
If Google tools are not connected, explain that the user should run /auth first.
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
          emitStatus(`Main agent delegated research: ${task}`);
          const result = await researchAgent.generate({
            prompt: task,
            abortSignal,
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
          emitStatus(`Main agent delegated ops work: ${task}`);
          const result = await operationsAgent.generate({
            prompt: task,
            abortSignal,
          });
          return result.text;
        },
      }),
      ...googleTools,
    },
  });
}
