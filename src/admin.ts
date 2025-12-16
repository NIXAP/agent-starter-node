/**
 * Admin Panel for Agent Configuration
 * 
 * Provides a web UI and REST API to manage agent configs stored in MariaDB.
 * Run with: pnpm admin
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import multer, { type StorageEngine } from 'multer';
import { z } from 'zod';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

import { createPool, type MySqlPool } from './db/mysql.js';
import { ensureSchema } from './db/schema.js';
import { AgentConfigSchema, KnowledgeItemSchema, type AgentConfig } from './config/types.js';

// Load env
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env.local') });

const PORT = Number(process.env.ADMIN_PORT ?? 8090);
const ADMIN_USER = process.env.ADMIN_USER ?? 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin';

// Uploads directory for knowledge files
const UPLOADS_DIR = resolve(__dirname, '..', 'uploads');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS middleware for public API
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Public API (no auth required) - for frontend integration
// ─────────────────────────────────────────────────────────────────────────────

// Always use 'oly-agent' as the LiveKit worker name (single worker for all agent types)
// The agent will read agentType from room metadata and load config from MySQL dynamically
function getLivekitAgentName(_agentType: string): string {
  return 'oly-agent';
}

// Public endpoint to list agents for frontend
app.get('/api/public/agents', async (_req: Request, res: Response) => {
  try {
    const pool = createPool();
    const [rows] = await pool.query(
      `SELECT agent_type, agent_name, greeting, voice, model FROM agent_configs ORDER BY agent_type`,
    ) as [Array<{ agent_type: string; agent_name: string; greeting: string; voice: string; model: string }>, unknown];
    await pool.end();

    // Transform to frontend-friendly format
    const agents = rows.map((r) => ({
      agentType: r.agent_type,
      // Fixed LiveKit agent name - ALWAYS use this for LiveKit dispatch
      livekitAgentName: getLivekitAgentName(r.agent_type),
      // Display name from DB (can be changed in admin)
      agentName: r.agent_name,
      displayName: r.agent_name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      description: r.greeting.slice(0, 100) + (r.greeting.length > 100 ? '...' : ''),
      voice: r.voice,
      model: r.model,
      // Default icon based on agent type
      icon: r.agent_type === 'restaurant' ? 'utensils' : r.agent_type === 'logistics' ? 'truck' : 'sparkles',
      language: 'English',
    }));

    res.json(agents);
  } catch (err) {
    console.error('GET /api/public/agents error:', err);
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Basic auth middleware (for admin panel)
// ─────────────────────────────────────────────────────────────────────────────

function basicAuth(req: Request, res: Response, next: NextFunction): void {
  // Skip auth for public endpoints
  if (req.path.startsWith('/api/public/')) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Panel"');
    res.status(401).send('Authentication required');
    return;
  }

  const base64 = authHeader.slice(6);
  const [user, pass] = Buffer.from(base64, 'base64').toString().split(':');
  if (user === ADMIN_USER && pass === ADMIN_PASSWORD) {
    next();
  } else {
    res.status(401).send('Invalid credentials');
  }
}

app.use(basicAuth);

// File upload setup
const storage: StorageEngine = multer.diskStorage({
  destination: async (_req: Request, _file: Express.Multer.File, cb: (error: Error | null, dest: string) => void) => {
    await mkdir(UPLOADS_DIR, { recursive: true });
    cb(null, UPLOADS_DIR);
  },
  filename: (_req: Request, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${unique}-${file.originalname}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB max

let pool: MySqlPool;

// ─────────────────────────────────────────────────────────────────────────────
// Database helpers
// ─────────────────────────────────────────────────────────────────────────────

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
  created_at: Date;
  updated_at: Date;
};

async function getAllAgents(): Promise<Array<{ agentType: string; config: AgentConfig }>> {
  const [rows] = await pool.query('SELECT * FROM agent_configs ORDER BY agent_type') as [DbAgentRow[], unknown];
  return rows.map((r: DbAgentRow) => ({
    agentType: r.agent_type,
    config: rowToConfig(r),
  }));
}

async function getAgent(agentType: string): Promise<AgentConfig | null> {
  const [rows] = await pool.query(
    'SELECT * FROM agent_configs WHERE agent_type = ?',
    [agentType],
  ) as [DbAgentRow[], unknown];
  const row = rows[0];
  return row ? rowToConfig(row) : null;
}

function rowToConfig(r: DbAgentRow): AgentConfig {
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
      const parsed = JSON.parse(r.knowledge_json) as unknown;
      const knowledge = z.array(KnowledgeItemSchema).safeParse(parsed);
      if (knowledge.success) base.knowledge = knowledge.data;
    } catch { /* ignore */ }
  }

  return base;
}

async function upsertAgent(agentType: string, config: AgentConfig): Promise<void> {
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

async function deleteAgent(agentType: string): Promise<boolean> {
  const [result] = await pool.query(
    'DELETE FROM agent_configs WHERE agent_type = ?',
    [agentType],
  ) as [{ affectedRows: number }, unknown];
  return result.affectedRows > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────────────────────────────────────

// List all agents
app.get('/api/agents', async (_req: Request, res: Response) => {
  try {
    const agents = await getAllAgents();
    res.json(agents);
  } catch (err) {
    console.error('GET /api/agents error:', err);
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

// Get single agent
app.get('/api/agents/:type', async (req: Request, res: Response) => {
  try {
    const config = await getAgent(req.params.type!);
    if (!config) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json({ agentType: req.params.type, config });
  } catch (err) {
    console.error('GET /api/agents/:type error:', err);
    res.status(500).json({ error: 'Failed to fetch agent' });
  }
});

// Create or update agent
const UpsertAgentSchema = z.object({
  agentType: z.string().trim().min(1).max(64),
  config: AgentConfigSchema,
});

app.post('/api/agents', async (req: Request, res: Response) => {
  try {
    const body = UpsertAgentSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid request', details: body.error.format() });
      return;
    }
    await upsertAgent(body.data.agentType, body.data.config);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/agents error:', err);
    res.status(500).json({ error: 'Failed to save agent' });
  }
});

// Delete agent
app.delete('/api/agents/:type', async (req: Request, res: Response) => {
  try {
    const deleted = await deleteAgent(req.params.type!);
    if (!deleted) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/agents/:type error:', err);
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});

// Upload file for knowledge
app.post('/api/upload', upload.single('file'), (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }
  res.json({
    filename: req.file.filename,
    originalName: req.file.originalname,
    path: `/uploads/${req.file.filename}`,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin UI (single-page HTML)
// ─────────────────────────────────────────────────────────────────────────────

const HTML_UI = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Oly Agent Admin</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0a0a0f;
      --bg-card: #12121a;
      --bg-input: #1a1a24;
      --border: #2a2a3a;
      --text: #e4e4eb;
      --text-muted: #8888a0;
      --primary: #6366f1;
      --primary-hover: #818cf8;
      --danger: #ef4444;
      --danger-hover: #f87171;
      --success: #10b981;
      --accent: #f59e0b;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Space Grotesk', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      background-image: 
        radial-gradient(ellipse at 20% 0%, rgba(99, 102, 241, 0.15) 0%, transparent 50%),
        radial-gradient(ellipse at 80% 100%, rgba(245, 158, 11, 0.1) 0%, transparent 50%);
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 2rem;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--border);
    }

    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      background: linear-gradient(135deg, var(--primary) 0%, var(--accent) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .btn {
      font-family: inherit;
      font-size: 0.875rem;
      font-weight: 500;
      padding: 0.625rem 1.25rem;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
    }

    .btn-primary {
      background: var(--primary);
      color: white;
    }
    .btn-primary:hover { background: var(--primary-hover); }

    .btn-danger {
      background: var(--danger);
      color: white;
    }
    .btn-danger:hover { background: var(--danger-hover); }

    .btn-ghost {
      background: transparent;
      color: var(--text-muted);
      border: 1px solid var(--border);
    }
    .btn-ghost:hover { 
      background: var(--bg-input); 
      color: var(--text);
    }

    .grid {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 2rem;
    }

    .sidebar {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1rem;
      height: fit-content;
      position: sticky;
      top: 2rem;
    }

    .agent-list {
      list-style: none;
    }

    .agent-item {
      padding: 0.875rem 1rem;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.25rem;
    }

    .agent-item:hover { background: var(--bg-input); }
    .agent-item.active { 
      background: var(--primary);
      color: white;
    }

    .agent-item .name {
      font-weight: 500;
    }

    .agent-item .type {
      font-size: 0.75rem;
      color: var(--text-muted);
      font-family: 'JetBrains Mono', monospace;
    }

    .agent-item.active .type { color: rgba(255,255,255,0.7); }

    .main-content {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2rem;
    }

    .form-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
    }

    .form-header h2 {
      font-size: 1.25rem;
      font-weight: 600;
    }

    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.5rem;
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .form-group.full { grid-column: 1 / -1; }

    label {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--text-muted);
    }

    input, textarea, select {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.875rem;
      padding: 0.75rem 1rem;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      transition: border-color 0.2s;
    }

    input:focus, textarea:focus, select:focus {
      outline: none;
      border-color: var(--primary);
    }

    textarea {
      resize: vertical;
      min-height: 120px;
    }

    .knowledge-section {
      margin-top: 2rem;
      padding-top: 2rem;
      border-top: 1px solid var(--border);
    }

    .knowledge-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }

    .knowledge-header h3 {
      font-size: 1rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .knowledge-actions {
      display: flex;
      gap: 0.5rem;
    }

    .knowledge-list {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .knowledge-item {
      display: flex;
      align-items: flex-start;
      gap: 1rem;
      padding: 1rem;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 8px;
    }

    .knowledge-item .type-badge {
      font-size: 0.625rem;
      font-weight: 600;
      text-transform: uppercase;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      background: var(--primary);
      color: white;
      flex-shrink: 0;
    }

    .knowledge-item .type-badge.website { background: #0ea5e9; }
    .knowledge-item .type-badge.file { background: #8b5cf6; }
    .knowledge-item .type-badge.page { background: #10b981; }

    .knowledge-item .content {
      flex: 1;
      min-width: 0;
    }

    .knowledge-item .title {
      font-weight: 500;
      margin-bottom: 0.25rem;
    }

    .knowledge-item .value {
      font-size: 0.8rem;
      color: var(--text-muted);
      word-break: break-all;
      font-family: 'JetBrains Mono', monospace;
    }

    .knowledge-item .remove-btn {
      background: none;
      border: none;
      color: var(--danger);
      cursor: pointer;
      padding: 0.25rem;
      font-size: 1.25rem;
      line-height: 1;
    }

    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.7);
      backdrop-filter: blur(4px);
      z-index: 100;
      align-items: center;
      justify-content: center;
    }

    .modal-overlay.active { display: flex; }

    .modal {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2rem;
      width: 90%;
      max-width: 500px;
    }

    .modal h3 {
      margin-bottom: 1.5rem;
    }

    .modal .form-group { margin-bottom: 1rem; }

    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.75rem;
      margin-top: 1.5rem;
    }

    .empty-state {
      text-align: center;
      padding: 4rem 2rem;
      color: var(--text-muted);
    }

    .empty-state h3 {
      font-size: 1.25rem;
      margin-bottom: 0.5rem;
      color: var(--text);
    }

    .toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      padding: 1rem 1.5rem;
      border-radius: 8px;
      background: var(--success);
      color: white;
      font-weight: 500;
      transform: translateY(100px);
      opacity: 0;
      transition: all 0.3s;
    }

    .toast.error { background: var(--danger); }
    .toast.active { transform: translateY(0); opacity: 1; }

    @media (max-width: 900px) {
      .grid { grid-template-columns: 1fr; }
      .sidebar { position: static; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🤖 Oly Agent Admin</h1>
      <button class="btn btn-primary" onclick="showNewAgentModal()">+ New Agent</button>
    </header>

    <div class="grid">
      <aside class="sidebar">
        <ul class="agent-list" id="agentList"></ul>
      </aside>

      <main class="main-content" id="mainContent">
        <div class="empty-state">
          <h3>Select an agent</h3>
          <p>Choose an agent from the list or create a new one.</p>
        </div>
      </main>
    </div>
  </div>

  <!-- New Agent Modal -->
  <div class="modal-overlay" id="newAgentModal">
    <div class="modal">
      <h3>Create New Agent</h3>
      <div class="form-group">
        <label>Agent Type (ID)</label>
        <input type="text" id="newAgentType" placeholder="e.g., support, sales, assistant">
      </div>
      <div class="form-group">
        <label>Agent Name</label>
        <input type="text" id="newAgentName" placeholder="Display name">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal('newAgentModal')">Cancel</button>
        <button class="btn btn-primary" onclick="createNewAgent()">Create</button>
      </div>
    </div>
  </div>

  <!-- Knowledge Modal -->
  <div class="modal-overlay" id="knowledgeModal">
    <div class="modal">
      <h3 id="knowledgeModalTitle">Add Knowledge</h3>
      <div class="form-group">
        <label>Type</label>
        <select id="knowledgeType">
          <option value="website">🌐 Website Import</option>
          <option value="file">📁 Upload File</option>
          <option value="page">📝 Add Page</option>
        </select>
      </div>
      <div class="form-group">
        <label>Title (optional)</label>
        <input type="text" id="knowledgeTitle" placeholder="Knowledge title">
      </div>
      <div class="form-group" id="knowledgeValueGroup">
        <label id="knowledgeValueLabel">URL</label>
        <input type="text" id="knowledgeValue" placeholder="https://...">
        <textarea id="knowledgeValueText" style="display:none" placeholder="Enter content..."></textarea>
        <input type="file" id="knowledgeFile" style="display:none">
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal('knowledgeModal')">Cancel</button>
        <button class="btn btn-primary" onclick="addKnowledge()">Add</button>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    let agents = [];
    let currentAgent = null;
    let currentKnowledge = [];

    // API helpers
    async function api(method, path, body) {
      const res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Request failed');
      }
      return res.json();
    }

    function toast(msg, isError = false) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.className = 'toast' + (isError ? ' error' : '');
      el.classList.add('active');
      setTimeout(() => el.classList.remove('active'), 3000);
    }

    // Load agents
    async function loadAgents() {
      try {
        agents = await api('GET', '/api/agents');
        renderAgentList();
      } catch (err) {
        toast('Failed to load agents: ' + err.message, true);
      }
    }

    function renderAgentList() {
      const list = document.getElementById('agentList');
      if (agents.length === 0) {
        list.innerHTML = '<li style="padding: 1rem; color: var(--text-muted);">No agents yet</li>';
        return;
      }
      list.innerHTML = agents.map(a => \`
        <li class="agent-item \${currentAgent?.agentType === a.agentType ? 'active' : ''}" 
            onclick="selectAgent('\${a.agentType}')">
          <div>
            <div class="name">\${a.config.agentName}</div>
            <div class="type">\${a.agentType}</div>
          </div>
        </li>
      \`).join('');
    }

    async function selectAgent(type) {
      try {
        const data = await api('GET', '/api/agents/' + type);
        currentAgent = data;
        currentKnowledge = data.config.knowledge || [];
        renderAgentForm();
        renderAgentList();
      } catch (err) {
        toast('Failed to load agent: ' + err.message, true);
      }
    }

    function renderAgentForm() {
      if (!currentAgent) {
        document.getElementById('mainContent').innerHTML = \`
          <div class="empty-state">
            <h3>Select an agent</h3>
            <p>Choose an agent from the list or create a new one.</p>
          </div>
        \`;
        return;
      }

      const c = currentAgent.config;
      document.getElementById('mainContent').innerHTML = \`
        <div class="form-header">
          <h2>\${c.agentName}</h2>
          <div style="display: flex; gap: 0.5rem;">
            <button class="btn btn-primary" onclick="saveAgent()">Save Changes</button>
            <button class="btn btn-danger" onclick="deleteCurrentAgent()">Delete</button>
          </div>
        </div>

        <div class="form-grid">
          <div class="form-group">
            <label>Agent Type (ID)</label>
            <input type="text" id="agentType" value="\${currentAgent.agentType}" readonly style="opacity: 0.6;">
          </div>
          <div class="form-group">
            <label>Agent Name</label>
            <input type="text" id="agentName" value="\${c.agentName}">
          </div>
          <div class="form-group">
            <label>Voice</label>
            <input type="text" id="voice" value="\${c.voice}">
          </div>
          <div class="form-group">
            <label>Model</label>
            <select id="model">
              <option value="gpt-4o" \${c.model === 'gpt-4o' ? 'selected' : ''}>gpt-4o</option>
              <option value="gpt-4o-mini" \${c.model === 'gpt-4o-mini' ? 'selected' : ''}>gpt-4o-mini</option>
              <option value="gpt-4-turbo" \${c.model === 'gpt-4-turbo' ? 'selected' : ''}>gpt-4-turbo</option>
            </select>
          </div>
          <div class="form-group">
            <label>TTS Model</label>
            <input type="text" id="ttsModel" value="\${c.ttsModel}">
          </div>
          <div class="form-group">
            <label>Temperature</label>
            <input type="number" id="temperature" value="\${c.temperature}" step="0.1" min="0" max="2">
          </div>
          <div class="form-group">
            <label>Speaking Rate</label>
            <input type="number" id="speakingRate" value="\${c.speakingRate}" step="0.1" min="0.5" max="2">
          </div>
          <div class="form-group full">
            <label>Greeting</label>
            <textarea id="greeting">\${c.greeting}</textarea>
          </div>
          <div class="form-group full">
            <label>Instructions</label>
            <textarea id="instructions" style="min-height: 200px;">\${c.instructions}</textarea>
          </div>
        </div>

        <div class="knowledge-section">
          <div class="knowledge-header">
            <h3>📚 Knowledge</h3>
            <div class="knowledge-actions">
              <button class="btn btn-ghost" onclick="openKnowledgeModal('website')">🌐 Website</button>
              <button class="btn btn-ghost" onclick="openKnowledgeModal('file')">📁 File</button>
              <button class="btn btn-ghost" onclick="openKnowledgeModal('page')">📝 Page</button>
            </div>
          </div>
          <div class="knowledge-list" id="knowledgeList"></div>
        </div>
      \`;

      renderKnowledgeList();
    }

    function renderKnowledgeList() {
      const list = document.getElementById('knowledgeList');
      if (!list) return;

      if (currentKnowledge.length === 0) {
        list.innerHTML = '<div style="color: var(--text-muted); padding: 1rem;">No knowledge items. Add business info the agent can use to answer questions.</div>';
        return;
      }

      list.innerHTML = currentKnowledge.map((k, i) => \`
        <div class="knowledge-item">
          <span class="type-badge \${k.type}">\${k.type}</span>
          <div class="content">
            \${k.title ? \`<div class="title">\${k.title}</div>\` : ''}
            <div class="value">\${k.value.length > 200 ? k.value.slice(0, 200) + '...' : k.value}</div>
          </div>
          <button class="remove-btn" onclick="removeKnowledge(\${i})">×</button>
        </div>
      \`).join('');
    }

    function removeKnowledge(index) {
      currentKnowledge.splice(index, 1);
      renderKnowledgeList();
    }

    function openKnowledgeModal(type) {
      document.getElementById('knowledgeType').value = type;
      updateKnowledgeModalFields();
      document.getElementById('knowledgeTitle').value = '';
      document.getElementById('knowledgeValue').value = '';
      document.getElementById('knowledgeValueText').value = '';
      document.getElementById('knowledgeModal').classList.add('active');
    }

    document.getElementById('knowledgeType').addEventListener('change', updateKnowledgeModalFields);

    function updateKnowledgeModalFields() {
      const type = document.getElementById('knowledgeType').value;
      const labelEl = document.getElementById('knowledgeValueLabel');
      const inputEl = document.getElementById('knowledgeValue');
      const textEl = document.getElementById('knowledgeValueText');
      const fileEl = document.getElementById('knowledgeFile');

      inputEl.style.display = 'none';
      textEl.style.display = 'none';
      fileEl.style.display = 'none';

      if (type === 'website') {
        labelEl.textContent = 'URL';
        inputEl.placeholder = 'https://example.com/about';
        inputEl.style.display = 'block';
      } else if (type === 'file') {
        labelEl.textContent = 'File';
        fileEl.style.display = 'block';
      } else {
        labelEl.textContent = 'Content';
        textEl.placeholder = 'Enter knowledge content...';
        textEl.style.display = 'block';
      }
    }

    async function addKnowledge() {
      const type = document.getElementById('knowledgeType').value;
      const title = document.getElementById('knowledgeTitle').value.trim();
      let value = '';

      if (type === 'website') {
        value = document.getElementById('knowledgeValue').value.trim();
        if (!value) return toast('Please enter a URL', true);
      } else if (type === 'file') {
        const fileInput = document.getElementById('knowledgeFile');
        const file = fileInput.files[0];
        if (!file) return toast('Please select a file', true);

        // Upload file
        const formData = new FormData();
        formData.append('file', file);

        try {
          const res = await fetch('/api/upload', { method: 'POST', body: formData });
          const data = await res.json();
          value = data.path;
        } catch (err) {
          return toast('Failed to upload file: ' + err.message, true);
        }
      } else {
        value = document.getElementById('knowledgeValueText').value.trim();
        if (!value) return toast('Please enter content', true);
      }

      currentKnowledge.push({ type, title: title || undefined, value });
      renderKnowledgeList();
      closeModal('knowledgeModal');
    }

    async function saveAgent() {
      if (!currentAgent) return;

      const config = {
        agentName: document.getElementById('agentName').value.trim(),
        instructions: document.getElementById('instructions').value.trim(),
        greeting: document.getElementById('greeting').value.trim(),
        voice: document.getElementById('voice').value.trim(),
        model: document.getElementById('model').value,
        ttsModel: document.getElementById('ttsModel').value.trim(),
        temperature: parseFloat(document.getElementById('temperature').value),
        speakingRate: parseFloat(document.getElementById('speakingRate').value),
        knowledge: currentKnowledge.length > 0 ? currentKnowledge : undefined,
      };

      try {
        await api('POST', '/api/agents', { agentType: currentAgent.agentType, config });
        toast('Agent saved successfully!');
        await loadAgents();
      } catch (err) {
        toast('Failed to save: ' + err.message, true);
      }
    }

    async function deleteCurrentAgent() {
      if (!currentAgent) return;
      if (!confirm('Are you sure you want to delete this agent?')) return;

      try {
        await api('DELETE', '/api/agents/' + currentAgent.agentType);
        toast('Agent deleted');
        currentAgent = null;
        currentKnowledge = [];
        await loadAgents();
        renderAgentForm();
      } catch (err) {
        toast('Failed to delete: ' + err.message, true);
      }
    }

    // New agent modal
    function showNewAgentModal() {
      document.getElementById('newAgentType').value = '';
      document.getElementById('newAgentName').value = '';
      document.getElementById('newAgentModal').classList.add('active');
    }

    async function createNewAgent() {
      const agentType = document.getElementById('newAgentType').value.trim().toLowerCase().replace(/\\s+/g, '-');
      const agentName = document.getElementById('newAgentName').value.trim();

      if (!agentType || !agentName) {
        return toast('Please fill in all fields', true);
      }

      const config = {
        agentName,
        instructions: 'You are a helpful voice AI assistant.',
        greeting: 'Hello! How can I help you today?',
        voice: 'Alex',
        model: 'gpt-4o',
        ttsModel: 'inworld-tts-1',
        temperature: 1.0,
        speakingRate: 1.0,
      };

      try {
        await api('POST', '/api/agents', { agentType, config });
        closeModal('newAgentModal');
        toast('Agent created!');
        await loadAgents();
        await selectAgent(agentType);
      } catch (err) {
        toast('Failed to create: ' + err.message, true);
      }
    }

    function closeModal(id) {
      document.getElementById(id).classList.remove('active');
    }

    // Close modal on outside click
    document.querySelectorAll('.modal-overlay').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target === el) closeModal(el.id);
      });
    });

    // Init
    loadAgents();
  </script>
</body>
</html>`;

app.get('/', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(HTML_UI);
});

// ─────────────────────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  pool = createPool();
  await ensureSchema(pool);
  console.log('[Admin] Database schema ready');

  app.listen(PORT, () => {
    console.log(`[Admin] Server running at http://localhost:${PORT}`);
    console.log(`[Admin] Credentials: ${ADMIN_USER} / ${ADMIN_PASSWORD}`);
  });
}

main().catch((err) => {
  console.error('[Admin] Failed to start:', err);
  process.exit(1);
});

