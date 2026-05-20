// Backload + agent endpoint schemas. These are used by Backload Matching,
// Agent Playground, and shared fleet-config seeding endpoints.

import { z } from 'zod';

export const BackloadSeedRequest = z.object({
  region: z.string(),
});

export const BackloadSeedResponse = z.object({
  status: z.union([z.literal('ok'), z.literal('error')]),
  error: z.string().optional(),
}).passthrough();

export const AgentChatRequest = z.object({
  question: z.string(),
  region: z.string().nullable().optional(),
  history: z.array(z.object({ role: z.string(), content: z.string() })).optional(),
});

export const AgentToolResult = z.object({
  status: z.string().optional(),
}).passthrough();

export const AgentChatChunk = z.object({
  type: z.enum(['delta', 'tool_call', 'tool_result', 'done', 'error']),
  text: z.string().optional(),
  tool_result: AgentToolResult.optional(),
  error: z.string().optional(),
}).passthrough();

export type BackloadSeedRequest = z.infer<typeof BackloadSeedRequest>;
export type AgentChatRequest = z.infer<typeof AgentChatRequest>;
