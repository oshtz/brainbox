/**
 * Ollama Provider
 *
 * Integration with local Ollama servers for AI-powered features.
 */

import { invoke } from '@tauri-apps/api/core';
import {
  AIProvider,
  ProviderConfig,
  ProviderSettings,
  GenerateOptions,
  StreamCallbacks,
  PROVIDER_CONFIGS,
} from '../types';

export class OllamaProvider implements AIProvider {
  readonly type = 'ollama' as const;
  readonly config: ProviderConfig = PROVIDER_CONFIGS.ollama;
  private settings: ProviderSettings;

  constructor(settings: ProviderSettings) {
    this.settings = settings;
  }

  updateSettings(settings: ProviderSettings): void {
    this.settings = settings;
  }

  isConfigured(): boolean {
    return !!this.settings.baseUrl && !!this.settings.model;
  }

  supportsNativeTools(): boolean {
    // Ollama doesn't reliably support tool calling across all models
    // We use prompt-based fallback for consistency
    return false;
  }

  async listModels(): Promise<string[]> {
    try {
      const models = await invoke<string[]>('ollama_list_models', {
        baseUrl: this.settings.baseUrl,
      });
      return models;
    } catch (error) {
      console.error('Failed to list Ollama models:', error);
      return [];
    }
  }

  async generate(options: GenerateOptions): Promise<string> {
    const model = options.model || this.settings.model;
    if (!model) throw new Error('No model selected');

    const text = await invoke<string>('ollama_generate', {
      model,
      prompt: options.prompt,
      baseUrl: this.settings.baseUrl,
      system: options.system,
    });
    return text;
  }

  async streamGenerate(
    options: GenerateOptions,
    callbacks: StreamCallbacks
  ): Promise<() => void> {
    const model = options.model || this.settings.model;
    if (!model) throw new Error('No model selected');

    const streamId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const { listen } = await import('@tauri-apps/api/event');

    const unlisten = await listen('ollama-stream', (evt: unknown) => {
      const event = evt as { payload: { streamId: string; delta?: string; done?: boolean } };
      const payload = event.payload;
      if (!payload || payload.streamId !== streamId) return;
      if (payload.delta && callbacks.onToken) callbacks.onToken(payload.delta);
      if (payload.done && callbacks.onDone) callbacks.onDone();
    });

    try {
      await invoke('ollama_generate_stream', {
        model,
        prompt: options.prompt,
        baseUrl: this.settings.baseUrl,
        system: options.system,
        streamId,
      });
    } catch (error) {
      callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    }

    return () => unlisten();
  }
}
