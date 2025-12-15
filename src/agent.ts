import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  metrics,
  voice,
} from '@livekit/agents';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import * as openai from '@livekit/agents-plugin-openai';

import { InworldTTS } from './inworld-tts.js';

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// Use absolute path for .env.local so child processes can find it
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env.local') }); 

// Load agent configurations from file
const configPath = resolve(__dirname, '..', 'src', 'config.json');

interface AgentConfig {
  agentName: string;
  instructions: string;
  greeting: string;
  voice: string;
  model: string;
  ttsModel: string;
  temperature: number;
  speakingRate: number;
}

interface Config {
  agents: Record<string, AgentConfig>;
}

function loadConfig(): Config {
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

function getAgentConfig(config: Config, agentType: string): AgentConfig {
  const agentConfig = config.agents[agentType] ?? config.agents.default;
  if (!agentConfig) {
    throw new Error(`Agent type '${agentType}' not found and no default agent configured`);
  }
  return agentConfig;
}

// Get agent type from AGENT_TYPE env var (set per container/process)
const AGENT_TYPE = process.env.AGENT_TYPE || 'default';
const config = loadConfig();
const agentConfig = getAgentConfig(config, AGENT_TYPE);

console.log(`[Config] Loading agent type: ${AGENT_TYPE}`);
console.log(`[Config] Agent name: ${agentConfig.agentName}`);
console.log(`[Config] Voice: ${agentConfig.voice}, Model: ${agentConfig.model}`);

// Create the Assistant class with config-based instructions
class ConfiguredAssistant extends voice.Agent {
  constructor() {
    super({ instructions: agentConfig.instructions });
  }
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    console.log(`[Agent] Starting session for: ${agentConfig.agentName}`);

    // Set up a voice AI pipeline using config values
    const session = new voice.AgentSession({
      // Speech-to-text (STT) - force English language
      stt: new openai.STT({
        model: "gpt-4o-transcribe",
        language: "en",
      }),

      // Large Language Model (LLM)
      llm: new openai.LLM({
        model: agentConfig.model,
      }),

      // Text-to-speech (TTS)
      tts: new InworldTTS({
        voice: agentConfig.voice,
        model: agentConfig.ttsModel,
        temperature: agentConfig.temperature,
        speakingRate: agentConfig.speakingRate,
      }),

      // VAD and turn detection
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      vad: ctx.proc.userData.vad! as silero.VAD,
      voiceOptions: {
        preemptiveGeneration: true,
      },
    });

    // Metrics collection
    const usageCollector = new metrics.UsageCollector();
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
      usageCollector.collect(ev.metrics);
    });

    const logUsage = async () => {
      const summary = usageCollector.getSummary();
      console.log(`Usage: ${JSON.stringify(summary)}`);
    };

    ctx.addShutdownCallback(logUsage);

    // Join the room and connect to the user
    await ctx.connect();
    
    // Start the session
    await session.start({
      agent: new ConfiguredAssistant(),
      room: ctx.room,
    });

    // Agent speaks first with the configured greeting
    await session.say(agentConfig.greeting, { allowInterruptions: true });
  },
});

// Start agent with the configured agent name
cli.runApp(new ServerOptions({ 
  agent: fileURLToPath(import.meta.url),
  agentName: agentConfig.agentName,
}));
