import { z } from 'zod';

export const KnowledgeItemSchema = z.object({
  // Matches the “Knowledge” UI concepts: website import, upload file, add page
  type: z.enum(['website', 'file', 'page']),
  title: z.string().trim().min(1).optional(),
  value: z.string().trim().min(1),
});

export type KnowledgeItem = z.infer<typeof KnowledgeItemSchema>;

export const AgentConfigSchema = z.object({
  agentName: z.string().trim().min(1),
  instructions: z.string().trim().min(1),
  greeting: z.string().trim().min(1),
  voice: z.string().trim().min(1),
  model: z.string().trim().min(1),
  ttsModel: z.string().trim().min(1),
  temperature: z.number(),
  speakingRate: z.number(),
  knowledge: z.array(KnowledgeItemSchema).optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const ConfigSchema = z.object({
  agents: z.record(AgentConfigSchema),
});

export type Config = z.infer<typeof ConfigSchema>;


