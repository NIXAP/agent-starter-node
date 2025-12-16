/**
 * Seed Database from config.json
 * 
 * Imports existing agent configurations from src/config.json into MariaDB.
 * Run with: pnpm db:seed
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

import { createPool } from '../db/mysql.js';
import { ensureSchema } from '../db/schema.js';
import { ConfigSchema, type AgentConfig } from '../config/types.js';

// Load env
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '..', '.env.local') });

async function main() {
  console.log('[Seed] Loading config.json...');
  
  // Load config.json
  const configPath = resolve(__dirname, '..', 'config.json');
  const raw = await readFile(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  const config = ConfigSchema.parse(parsed);

  console.log(`[Seed] Found ${Object.keys(config.agents).length} agents`);

  // Connect to DB
  const pool = createPool();
  
  // Ensure schema exists
  await ensureSchema(pool);
  console.log('[Seed] Schema ready');

  // Insert agents
  for (const [agentType, agentConfig] of Object.entries(config.agents)) {
    await upsertAgent(pool, agentType, agentConfig);
    console.log(`[Seed] Upserted agent: ${agentType} (${agentConfig.agentName})`);
  }

  await pool.end();
  console.log('[Seed] Done!');
}

async function upsertAgent(
  pool: ReturnType<typeof createPool>,
  agentType: string,
  config: AgentConfig,
): Promise<void> {
  const knowledgeJson = config.knowledge ? JSON.stringify(config.knowledge) : null;

  await pool.query(
    `INSERT INTO agent_configs 
       (agent_type, agent_name, instructions, greeting, voice, model, tts_model, temperature, speaking_rate, knowledge_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       agent_name = VALUES(agent_name),
       instructions = VALUES(instructions),
       greeting = VALUES(greeting),
       voice = VALUES(voice),
       model = VALUES(model),
       tts_model = VALUES(tts_model),
       temperature = VALUES(temperature),
       speaking_rate = VALUES(speaking_rate),
       knowledge_json = VALUES(knowledge_json)`,
    [
      agentType,
      config.agentName,
      config.instructions,
      config.greeting,
      config.voice,
      config.model,
      config.ttsModel,
      config.temperature,
      config.speakingRate,
      knowledgeJson,
    ],
  );
}

main().catch((err) => {
  console.error('[Seed] Error:', err);
  process.exit(1);
});

