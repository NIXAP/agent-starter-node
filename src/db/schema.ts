import type { MySqlPool } from './mysql.js';

export async function ensureSchema(pool: MySqlPool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_configs (
      agent_type VARCHAR(64) NOT NULL PRIMARY KEY,
      agent_name VARCHAR(255) NOT NULL,
      instructions LONGTEXT NOT NULL,
      greeting LONGTEXT NOT NULL,
      voice VARCHAR(255) NOT NULL,
      model VARCHAR(255) NOT NULL,
      tts_model VARCHAR(255) NOT NULL,
      temperature DOUBLE NOT NULL DEFAULT 1.0,
      speaking_rate DOUBLE NOT NULL DEFAULT 1.0,
      knowledge_json LONGTEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
}


