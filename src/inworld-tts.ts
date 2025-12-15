/**
 * Custom Inworld TTS implementation for LiveKit Agents (Node.js)
 * Uses your own Inworld API key directly
 * 
 * API Documentation: https://docs.inworld.ai/docs/tts/tts
 */
import { tts } from '@livekit/agents';
import { AudioByteStream } from '@livekit/agents';
import WebSocket from 'ws';

const DEFAULT_BASE_URL = 'https://api.inworld.ai/';
const DEFAULT_WS_URL = 'wss://api.inworld.ai/';
const DEFAULT_MODEL = 'inworld-tts-1';
const DEFAULT_VOICE = 'Alex';
const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_ENCODING = 'LINEAR16';  // PCM for LiveKit compatibility
const DEFAULT_BIT_RATE = 64000;
const DEFAULT_TEMPERATURE = 1.1;
const DEFAULT_SPEAKING_RATE = 1.0;
const NUM_CHANNELS = 1;

export interface InworldTTSOptions {
  apiKey?: string;
  voice?: string;
  model?: string;
  sampleRate?: number;
  encoding?: 'LINEAR16' | 'MP3' | 'OGG_OPUS' | 'ALAW' | 'MULAW' | 'FLAC';
  bitRate?: number;
  temperature?: number;
  speakingRate?: number;
  baseUrl?: string;
  wsUrl?: string;
}

interface SynthesizeResult {
  result?: {
    audioContent?: string;
    timestampInfo?: unknown;
  };
  error?: {
    message: string;
    code: number;
  };
}

/**
 * Inworld TTS implementation for LiveKit Agents
 * 
 * @example
 * ```typescript
 * import { InworldTTS } from './inworld-tts.js';
 * 
 * const session = new voice.AgentSession({
 *   tts: new InworldTTS({
 *     apiKey: process.env.INWORLD_API_KEY,
 *     voice: 'Ashley',
 *     model: 'inworld-tts-1-max',
 *   }),
 *   // ... other options
 * });
 * ```
 */
export class InworldTTS extends tts.TTS {
  private apiKey: string;
  private voice: string;
  private model: string;
  private encoding: string;
  private bitRate: number;
  private temperature: number;
  private speakingRate: number;
  private baseUrl: string;
  private wsUrl: string;
  
  #closed = false;
  #streams = new Set<InworldSynthesizeStream>();

  constructor(opts: InworldTTSOptions = {}) {
    const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    
    super(sampleRate, NUM_CHANNELS, { streaming: true });

    const apiKey = opts.apiKey ?? process.env.INWORLD_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Inworld API key required. Set INWORLD_API_KEY environment variable or provide apiKey option.'
      );
    }

    this.apiKey = apiKey;
    this.voice = opts.voice ?? DEFAULT_VOICE;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.encoding = opts.encoding ?? DEFAULT_ENCODING;
    this.bitRate = opts.bitRate ?? DEFAULT_BIT_RATE;
    this.temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
    this.speakingRate = opts.speakingRate ?? DEFAULT_SPEAKING_RATE;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.wsUrl = opts.wsUrl ?? DEFAULT_WS_URL;
  }

  get label(): string {
    return 'inworld.TTS';
  }

  /**
   * Synthesize text to audio (non-streaming)
   */
  synthesize(text: string): tts.ChunkedStream {
    return new InworldChunkedStream(this, text);
  }

  /**
   * Create a streaming synthesis session
   */
  stream(): InworldSynthesizeStream {
    const stream = new InworldSynthesizeStream(this);
    this.#streams.add(stream);
    return stream;
  }

  /**
   * Update TTS options
   */
  updateOptions(opts: Partial<InworldTTSOptions>): void {
    if (opts.voice !== undefined) this.voice = opts.voice;
    if (opts.model !== undefined) this.model = opts.model;
    if (opts.temperature !== undefined) this.temperature = opts.temperature;
    if (opts.speakingRate !== undefined) this.speakingRate = opts.speakingRate;
  }

  /** @internal */
  getConfig() {
    return {
      apiKey: this.apiKey,
      voice: this.voice,
      model: this.model,
      encoding: this.encoding,
      bitRate: this.bitRate,
      sampleRate: this.sampleRate,
      temperature: this.temperature,
      speakingRate: this.speakingRate,
      baseUrl: this.baseUrl,
      wsUrl: this.wsUrl,
    };
  }

  override async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    
    for (const stream of this.#streams) {
      await stream.close();
    }
    this.#streams.clear();
  }
}

/**
 * Non-streaming chunked synthesis
 */
class InworldChunkedStream extends tts.ChunkedStream {
  private ttsInstance: InworldTTS;

  constructor(ttsInstance: InworldTTS, text: string) {
    super(text, ttsInstance);
    this.ttsInstance = ttsInstance;
  }

  get label(): string {
    return 'inworld.ChunkedStream';
  }

  protected async run(): Promise<void> {
    const config = this.ttsInstance.getConfig();
    const url = new URL('/tts/v1/voice:stream', config.baseUrl);

    const body = {
      text: this.inputText,
      voiceId: config.voice,
      modelId: config.model,
      audioConfig: {
        audioEncoding: config.encoding,
        bitrate: config.bitRate,
        sampleRateHertz: config.sampleRate,
        speakingRate: config.speakingRate,
      },
      temperature: config.temperature,
    };

    try {
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Inworld TTS error: ${response.status} - ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Failed to get response reader');
      }

      const decoder = new TextDecoder();
      const bstream = new AudioByteStream(config.sampleRate, NUM_CHANNELS);
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const data: SynthesizeResult = JSON.parse(line);

            if (data.error) {
              throw new Error(`Inworld API error: ${data.error.message}`);
            }

            if (data.result?.audioContent) {
              const audioBytes = Buffer.from(data.result.audioContent, 'base64');
              // Convert Buffer to ArrayBuffer
              const arrayBuffer = audioBytes.buffer.slice(
                audioBytes.byteOffset,
                audioBytes.byteOffset + audioBytes.byteLength
              );
              for (const frame of bstream.write(arrayBuffer)) {
                this.queue.put({
                  requestId: this.inputText.slice(0, 20),
                  segmentId: 'default',
                  frame,
                  final: false,
                });
              }
            }
          } catch (e) {
            if (e instanceof SyntaxError) {
              console.warn('Failed to parse Inworld response line:', line);
              continue;
            }
            throw e;
          }
        }
      }

      // Flush remaining audio
      for (const frame of bstream.flush()) {
        this.queue.put({
          requestId: this.inputText.slice(0, 20),
          segmentId: 'default',
          frame,
          final: true,
        });
      }

      // Signal end of stream - close the queue
      this.queue.close();
    } catch (error) {
      console.error('Inworld TTS synthesis error:', error);
      throw error;
    }
  }
}

/**
 * Streaming synthesis using WebSocket
 */
export class InworldSynthesizeStream extends tts.SynthesizeStream {
  private ttsInstance: InworldTTS;
  private ws: WebSocket | null = null;
  private contextId: string;
  private inputEnded = false;

  constructor(ttsInstance: InworldTTS) {
    super(ttsInstance);
    this.ttsInstance = ttsInstance;
    this.contextId = `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  get label(): string {
    return 'inworld.SynthesizeStream';
  }

  protected async run(): Promise<void> {
    const config = this.ttsInstance.getConfig();
    const wsUrl = new URL('/tts/v1/voice:streamBidirectional', config.wsUrl);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl.toString(), {
        headers: {
          'Authorization': `Basic ${config.apiKey}`,
        },
      });

      const bstream = new AudioByteStream(config.sampleRate, NUM_CHANNELS);
      let segmentStarted = false;

      this.ws.on('open', () => {
        // Create context
        const createMsg = {
          create: {
            voiceId: config.voice,
            modelId: config.model,
            audioConfig: {
              audioEncoding: config.encoding,
              sampleRateHertz: config.sampleRate,
              bitrate: config.bitRate,
              speakingRate: config.speakingRate,
            },
            temperature: config.temperature,
            bufferCharThreshold: 100,
            maxBufferDelayMs: 3000,
          },
          contextId: this.contextId,
        };
        this.ws!.send(JSON.stringify(createMsg));

        // Start processing input
        this.processInput();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          const result = msg.result;

          if (!result) return;

          // Check for errors
          const status = result.status;
          if (status?.code && status.code !== 0) {
            reject(new Error(`Inworld error: ${status.message || 'Unknown error'}`));
            return;
          }

          // Context created
          if (result.contextCreated) {
            return;
          }

          // Context closed - stream complete
          if (result.contextClosed) {
            // Flush remaining audio
            for (const frame of bstream.flush()) {
              this.queue.put({
                requestId: this.contextId,
                segmentId: this.contextId,
                frame,
                final: true,
              });
            }
            // Signal end of stream - close the queue
            this.queue.close();
            resolve();
            return;
          }

          // Audio chunk
          if (result.audioChunk?.audioContent) {
            if (!segmentStarted) {
              segmentStarted = true;
            }

            const audioBytes = Buffer.from(result.audioChunk.audioContent, 'base64');
            // Convert Buffer to ArrayBuffer
            const arrayBuffer = audioBytes.buffer.slice(
              audioBytes.byteOffset,
              audioBytes.byteOffset + audioBytes.byteLength
            );
            for (const frame of bstream.write(arrayBuffer)) {
              this.queue.put({
                requestId: this.contextId,
                segmentId: this.contextId,
                frame,
                final: false,
              });
            }
          }
        } catch (e) {
          console.warn('Failed to parse Inworld WebSocket message:', e);
        }
      });

      this.ws.on('error', (error) => {
        console.error('Inworld WebSocket error:', error);
        reject(error);
      });

      this.ws.on('close', () => {
        if (!this.inputEnded) {
          reject(new Error('Inworld WebSocket closed unexpectedly'));
        }
      });
    });
  }

  private async processInput(): Promise<void> {
    try {
      for await (const data of this.input) {
        if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) break;

        if (data === tts.SynthesizeStream.FLUSH_SENTINEL) {
          // Flush the context
          const flushMsg = { flush_context: {}, contextId: this.contextId };
          this.ws.send(JSON.stringify(flushMsg));
          continue;
        }

        // Send text
        const sendMsg = {
          send_text: { text: data },
          contextId: this.contextId,
        };
        this.ws.send(JSON.stringify(sendMsg));
      }

      // End input - flush and close context
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const flushMsg = { flush_context: {}, contextId: this.contextId };
        this.ws.send(JSON.stringify(flushMsg));

        const closeMsg = { close_context: {}, contextId: this.contextId };
        this.ws.send(JSON.stringify(closeMsg));
      }

      this.inputEnded = true;
    } catch (e) {
      console.error('Error processing input:', e);
    }
  }

  override async close(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    await super.close();
  }
}
