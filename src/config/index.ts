import { z } from 'zod';

import { loadConfigFromFile } from './providers/file.js';
import { loadConfigFromMysql } from './providers/mysql.js';
import { KnowledgeItemSchema, type AgentConfig, type Config, type KnowledgeItem } from './types.js';

type ConfigSource = 'file' | 'mysql';

const ConfigSourceSchema = z.enum(['file', 'mysql']);

function getConfigSource(): ConfigSource {
  const raw = process.env.CONFIG_SOURCE ?? 'file';
  return ConfigSourceSchema.parse(raw);
}

let cached: { loadedAtMs: number; config: Config } | undefined;

async function loadConfig(): Promise<Config> {
  const ttlMs = Number(process.env.CONFIG_CACHE_TTL_MS ?? 10_000);
  const now = Date.now();
  if (cached && now - cached.loadedAtMs < ttlMs) return cached.config;

  const source = getConfigSource();
  try {
    const config = source === 'mysql' ? await loadConfigFromMysql() : await loadConfigFromFile();
    cached = { loadedAtMs: now, config };
    return config;
  } catch (e) {
    // Safety net: if mysql fails, fallback to file so the agent can still boot.
    if (source === 'mysql') {
      const config = await loadConfigFromFile();
      cached = { loadedAtMs: now, config };
      return config;
    }
    throw e;
  }
}

export async function getAgentConfig(agentType: string): Promise<AgentConfig> {
  const config = await loadConfig();
  const agentConfig = config.agents[agentType] ?? config.agents.default;
  if (!agentConfig) {
    throw new Error(`Agent type '${agentType}' not found and no default agent configured`);
  }
  return agentConfig;
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function resolveKnowledgeText(items: KnowledgeItem[]): Promise<string[]> {
  const maxCharsPerItem = Number(process.env.KNOWLEDGE_MAX_CHARS_PER_ITEM ?? 25_000);

  const out: string[] = [];
  for (const item of items) {
    if (item.type === 'page') {
      out.push(item.value.slice(0, maxCharsPerItem));
      continue;
    }

    if (item.type === 'website') {
      // Best-effort. If the fetch fails, we just keep the URL reference.
      try {
        const res = await fetch(item.value, { redirect: 'follow' });
        const html = await res.text();
        const text = stripHtmlToText(html).slice(0, maxCharsPerItem);
        out.push(text.length ? text : `Website: ${item.value}`);
      } catch {
        out.push(`Website: ${item.value}`);
      }
      continue;
    }

    if (item.type === 'file') {
      // For now, include just the file reference; the admin can upload, but parsing is app-specific.
      out.push(`File: ${item.value}`);
    }
  }

  return out;
}

export async function buildInstructionsWithKnowledge(agentConfig: AgentConfig): Promise<string> {
  const itemsRaw = agentConfig.knowledge ?? [];
  const items = z.array(KnowledgeItemSchema).safeParse(itemsRaw);
  const knowledgeItems = items.success ? items.data : [];

  if (knowledgeItems.length === 0) return agentConfig.instructions;

  const resolved = await resolveKnowledgeText(knowledgeItems);
  const knowledgeBlock = resolved
    .filter(Boolean)
    .map((t, i) => `- [${i + 1}] ${t}`)
    .join('\n');

  return `${agentConfig.instructions}\n\nAdditional knowledge (use it when relevant):\n${knowledgeBlock}\n`;
}


