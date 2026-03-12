import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  createTask,
  deleteTask,
  listTasks,
  updateTask,
  type LocalTaskPriority,
  type LocalTaskStatus,
} from "./db";

const taskStatusSchema = z.enum(["todo", "in_progress", "done", "backlog"]);
const taskPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);

function formatDateInZone(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });

  return formatter.format(date);
}

function safeFormatDateInZone(date: Date, timeZone: string) {
  try {
    return {
      timeZone,
      formatted: formatDateInZone(date, timeZone),
    };
  } catch {
    return {
      timeZone: "UTC",
      formatted: formatDateInZone(date, "UTC"),
      warning: `Invalid timezone "${timeZone}". Fell back to UTC.`,
    };
  }
}

async function geocodeCity(
  city: string,
): Promise<{ latitude: number; longitude: number } | null> {
  try {
    const response = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
    );

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      results?: Array<{ latitude: number; longitude: number }>;
    };

    const result = data.results?.[0];
    return result
      ? {
          latitude: result.latitude,
          longitude: result.longitude,
        }
      : null;
  } catch {
    return null;
  }
}

function mapTask(task: {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function createDirectTools(): ToolSet {
  return {
    getCurrentTime: tool({
      description:
        "Get the current date and time. Optionally include an IANA timezone like America/New_York.",
      inputSchema: z.object({
        timeZone: z.string().min(1).optional(),
      }),
      execute: async ({ timeZone }) => {
        const now = new Date();
        const zonedTime = safeFormatDateInZone(now, timeZone ?? "UTC");

        return {
          success: true,
          iso8601: now.toISOString(),
          unixMs: now.getTime(),
          timeZone: zonedTime.timeZone,
          formatted: zonedTime.formatted,
          utc: formatDateInZone(now, "UTC"),
          ...(zonedTime.warning ? { warning: zonedTime.warning } : {}),
        };
      },
    }),
    getWeather: tool({
      description:
        "Get current weather for a city or coordinates using Open-Meteo.",
      inputSchema: z
        .object({
          city: z.string().min(1).optional(),
          latitude: z.number().optional(),
          longitude: z.number().optional(),
        })
        .refine(
          (data) =>
            (data.city != null && data.city !== "") ||
            (data.latitude != null && data.longitude != null),
          {
            message:
              "Provide either city or both latitude and longitude.",
          },
        ),
      execute: async (input) => {
        let latitude: number;
        let longitude: number;

        if (input.city) {
          const coords = await geocodeCity(input.city);
          if (!coords) {
            return {
              success: false,
              error: `Could not find coordinates for "${input.city}".`,
            };
          }

          latitude = coords.latitude;
          longitude = coords.longitude;
        } else if (
          input.latitude != null &&
          input.longitude != null
        ) {
          latitude = input.latitude;
          longitude = input.longitude;
        } else {
          return {
            success: false,
            error:
              "Provide either city or both latitude and longitude.",
          };
        }

        const response = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=sunrise,sunset&timezone=auto`,
        );

        if (!response.ok) {
          return {
            success: false,
            error: `Weather lookup failed with HTTP ${response.status}.`,
          };
        }

        const weatherData = (await response.json()) as Record<string, unknown>;

        return {
          success: true,
          ...(input.city ? { city: input.city } : {}),
          latitude,
          longitude,
          weather: weatherData,
        };
      },
    }),
    createTask: tool({
      description:
        "Create a local task in the subagents playground task list.",
      inputSchema: z.object({
        title: z.string().min(1).max(500),
        description: z.string().optional(),
        status: taskStatusSchema.default("todo"),
        priority: taskPrioritySchema.default("medium"),
        dueDate: z.string().datetime().optional(),
      }),
      execute: async ({ title, description, status, priority, dueDate }) => {
        const task = await createTask({
          title,
          description: description ?? null,
          status: status as LocalTaskStatus,
          priority: priority as LocalTaskPriority,
          dueDate: dueDate ?? null,
        });

        return {
          success: true,
          message: `Created task "${task.title}".`,
          task: mapTask(task),
        };
      },
    }),
    listTasks: tool({
      description:
        "List local tasks from the subagents playground, optionally filtered by status or priority.",
      inputSchema: z.object({
        status: taskStatusSchema.optional(),
        priority: taskPrioritySchema.optional(),
      }),
      execute: async ({ status, priority }) => {
        const tasks = (await listTasks()).filter((task) => {
          if (status && task.status !== status) {
            return false;
          }
          if (priority && task.priority !== priority) {
            return false;
          }
          return true;
        });

        return {
          success: true,
          count: tasks.length,
          tasks: tasks.map(mapTask),
        };
      },
    }),
    updateTask: tool({
      description:
        "Update a local task by id. Use listTasks first if you need to find the right id.",
      inputSchema: z.object({
        taskId: z.string().uuid(),
        title: z.string().min(1).max(500).optional(),
        description: z.string().nullable().optional(),
        status: taskStatusSchema.optional(),
        priority: taskPrioritySchema.optional(),
        dueDate: z.string().datetime().nullable().optional(),
      }),
      execute: async ({
        taskId,
        title,
        description,
        status,
        priority,
        dueDate,
      }) => {
        const task = await updateTask(taskId, {
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(status !== undefined ? { status: status as LocalTaskStatus } : {}),
          ...(priority !== undefined
            ? { priority: priority as LocalTaskPriority }
            : {}),
          ...(dueDate !== undefined ? { dueDate } : {}),
        });

        if (!task) {
          return {
            success: false,
            error: `No task found with id ${taskId}.`,
          };
        }

        return {
          success: true,
          message: `Updated task "${task.title}".`,
          task: mapTask(task),
        };
      },
    }),
    deleteTask: tool({
      description:
        "Delete a local task by id. This removes it from the subagents playground task list.",
      inputSchema: z.object({
        taskId: z.string().uuid(),
      }),
      execute: async ({ taskId }) => {
        const deleted = await deleteTask(taskId);
        return deleted
          ? {
              success: true,
              message: "Task deleted successfully.",
            }
          : {
              success: false,
              error: `No task found with id ${taskId}.`,
            };
      },
    }),
  };
}
