import { z } from 'zod';
import { ConfigSchema, KnowledgeItemSchema, type AgentConfig, type Config } from '../types.js';
import { createPool } from '../../db/mysql.js';

type DbAgentRow = {
  agent_type: string;
  agent_name: string;
  instructions: string;
  greeting: string;
  voice: string;
  model: string;
  tts_model: string;
  temperature: number;
  speaking_rate: number;
  knowledge_json: string | null;
};

export async function loadConfigFromMysql(): Promise<Config> {
  const pool = createPool();
  const [rows] = await pool.query(
    `SELECT agent_type, agent_name, instructions, greeting, voice, model, tts_model, temperature, speaking_rate, knowledge_json
     FROM agent_configs`,
  ) as [DbAgentRow[], unknown];

  const agents: Record<string, AgentConfig> = {};
  for (const r of rows as DbAgentRow[]) {
    const base: AgentConfig = {
      agentName: r.agent_name,
      instructions: r.instructions,
      greeting: r.greeting,
      voice: r.voice,
      model: r.model,
      ttsModel: r.tts_model,
      temperature: Number(r.temperature),
      speakingRate: Number(r.speaking_rate),
    };

    if (r.knowledge_json) {
      try {
        const knowledgeParsed = JSON.parse(r.knowledge_json) as unknown;
        const knowledge = z.array(KnowledgeItemSchema).safeParse(knowledgeParsed);
        agents[r.agent_type] = knowledge.success ? { ...base, knowledge: knowledge.data } : base;
      } catch {
        agents[r.agent_type] = base;
      }
    } else {
      agents[r.agent_type] = base;
    }
  }

  await pool.end();
  return ConfigSchema.parse({ agents });
}


