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
import { buildInstructionsWithKnowledge, getAgentConfig } from './config/index.js';

// Use absolute path for .env.local so child processes can find it
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env.local') }); 

// Always use 'oly-agent' as the LiveKit worker name (single worker for all agent types)
const LIVEKIT_AGENT_NAME = 'oly-agent';

console.log(`[Agent] Starting worker as: ${LIVEKIT_AGENT_NAME}`);
console.log(`[Agent] Will load config dynamically from room metadata (agentType)`);

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    // Join the room first to access metadata
    await ctx.connect();

    // Read agentType from room metadata (set by frontend in token)
    let agentType = 'default';
    try {
      const roomMetadata = ctx.room.metadata;
      if (roomMetadata) {
        const parsed = JSON.parse(roomMetadata) as { agentType?: string };
        if (parsed.agentType) {
          agentType = parsed.agentType;
        }
      }
    } catch (err) {
      console.warn(`[Agent] Failed to parse room metadata, using default agentType:`, err);
    }

    console.log(`[Agent] Loading config for agentType: ${agentType}`);

    // Load config dynamically from MySQL based on agentType
    const agentConfig = await getAgentConfig(agentType);
    const instructionsWithKnowledge = await buildInstructionsWithKnowledge(agentConfig);

    console.log(`[Agent] Agent name: ${agentConfig.agentName}`);
    console.log(`[Agent] Voice: ${agentConfig.voice}, Model: ${agentConfig.model}`);

    // Create the Assistant class with config-based instructions
    class ConfiguredAssistant extends voice.Agent {
      constructor() {
        super({ instructions: instructionsWithKnowledge });
      }
    }

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
    
    // Start the session
    await session.start({
      agent: new ConfiguredAssistant(),
      room: ctx.room,
    });

    // Agent speaks first with the configured greeting
    await session.say(agentConfig.greeting, { allowInterruptions: true });
  },
});

// Start agent with the fixed LiveKit agent name (based on AGENT_TYPE, not DB)
cli.runApp(new ServerOptions({ 
  agent: fileURLToPath(import.meta.url),
  agentName: LIVEKIT_AGENT_NAME,
}));
