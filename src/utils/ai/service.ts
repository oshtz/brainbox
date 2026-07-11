/**
 * AI Service
 *
 * Manages AI providers and provides a unified interface for AI operations.
 */

import {
  AISettings,
  AIProvider,
  ProviderType,
  ProviderSettings,
  GenerateOptions,
  StreamCallbacks,
  getDefaultSettings,
  PROVIDER_CONFIGS,
} from './types';
import {
  OllamaProvider,
  LMStudioProvider,
  OpenRouterProvider,
  OpenAIProvider,
  AnthropicProvider,
  GoogleProvider,
} from './providers';
import { invoke } from '@tauri-apps/api/core';

const SETTINGS_KEY = 'brainbox-ai-settings';

export function settingsForStorage(settings: AISettings): AISettings {
  const providers = Object.fromEntries(
    Object.entries(settings.providers).map(([type, provider]) => {
      const { apiKey: _secret, ...nonSecret } = provider;
      return [type, nonSecret];
    })
  ) as AISettings['providers'];
  return { ...settings, providers };
}

class AIService {
  private settings: AISettings;
  private providers: Map<ProviderType, AIProvider> = new Map();

  constructor() {
    this.settings = this.loadSettings();
    this.initializeProviders();
    void this.loadSecureApiKeys();
  }

  private loadSettings(): AISettings {
    try {
      const saved = localStorage.getItem(SETTINGS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        // Merge with defaults to handle new providers
        const defaults = getDefaultSettings();
        const merged = {
          ...defaults,
          ...parsed,
          providers: {
            ...defaults.providers,
            ...parsed.providers,
          },
        };
        // Migrate legacy plaintext keys into memory for this session, then scrub
        // them from browser storage. Secure persistence is handled by Rust.
        this.persistNonSecretSettings(merged);
        return merged;
      }
    } catch (error) {
      console.error('Failed to load AI settings:', error);
    }

    // Migrate from old Ollama settings if present
    const oldUrl = localStorage.getItem('brainbox-ollama-url');
    const oldModel = localStorage.getItem('brainbox-ollama-model');
    const oldSystemPrompt = localStorage.getItem('brainbox-brainy-system-prompt');

    const settings = getDefaultSettings();
    if (oldUrl) settings.providers.ollama.baseUrl = oldUrl;
    if (oldModel) settings.providers.ollama.model = oldModel;
    if (oldSystemPrompt) settings.systemPrompt = oldSystemPrompt;

    return settings;
  }

  private saveSettings(): void {
    this.persistNonSecretSettings(this.settings);
  }

  private persistNonSecretSettings(settings: AISettings): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsForStorage(settings)));
    } catch (error) {
      console.error('Failed to save AI settings:', error);
    }
  }

  private async loadSecureApiKeys(): Promise<void> {
    const cloudProviders: ProviderType[] = ['openrouter', 'openai', 'anthropic', 'google'];
    await Promise.all(cloudProviders.map(async (type) => {
      try {
        const apiKey = await invoke<string | null>('get_ai_secret', { provider: type });
        const legacyApiKey = this.settings.providers[type].apiKey?.trim();
        const resolvedApiKey = apiKey || legacyApiKey;
        if (!resolvedApiKey) return;
        if (!apiKey && legacyApiKey) {
          await invoke('set_ai_secret', { provider: type, secret: legacyApiKey });
        }
        this.settings.providers[type] = { ...this.settings.providers[type], apiKey: resolvedApiKey };
        const provider = this.providers.get(type);
        if (provider && 'updateSettings' in provider) {
          (provider as OllamaProvider).updateSettings(this.settings.providers[type]);
        }
      } catch (error) {
        console.warn(`Secure credentials unavailable for ${type}:`, error);
      }
    }));
    try {
      window.dispatchEvent(new CustomEvent('ai-settings-changed'));
    } catch {
      // Tests and non-window runtimes do not need the notification.
    }
  }

  private initializeProviders(): void {
    const createProvider = (type: ProviderType, settings: ProviderSettings): AIProvider => {
      switch (type) {
        case 'ollama':
          return new OllamaProvider(settings);
        case 'lmstudio':
          return new LMStudioProvider(settings);
        case 'openrouter':
          return new OpenRouterProvider(settings);
        case 'openai':
          return new OpenAIProvider(settings);
        case 'anthropic':
          return new AnthropicProvider(settings);
        case 'google':
          return new GoogleProvider(settings);
        default:
          throw new Error(`Unknown provider type: ${type}`);
      }
    };

    for (const [type, providerSettings] of Object.entries(this.settings.providers)) {
      this.providers.set(type as ProviderType, createProvider(type as ProviderType, providerSettings));
    }
  }

  // Settings management
  getSettings(): AISettings {
    return { ...this.settings };
  }

  getProviderSettings(type: ProviderType): ProviderSettings {
    return { ...this.settings.providers[type] };
  }

  updateProviderSettings(type: ProviderType, settings: Partial<ProviderSettings>): void {
    this.settings.providers[type] = {
      ...this.settings.providers[type],
      ...settings,
    };

    // Update provider instance
    const provider = this.providers.get(type);
    if (provider && 'updateSettings' in provider) {
      (provider as OllamaProvider).updateSettings(this.settings.providers[type]);
    }

    this.saveSettings();
    if (Object.prototype.hasOwnProperty.call(settings, 'apiKey')) {
      void invoke('set_ai_secret', {
        provider: type,
        secret: settings.apiKey?.trim() || null,
      }).catch((error) => {
        console.warn(`Could not persist ${type} API key securely; it will remain session-only:`, error);
      });
    }
  }

  setActiveProvider(type: ProviderType): void {
    this.settings.activeProvider = type;
    this.saveSettings();
  }

  getActiveProvider(): AIProvider | null {
    return this.providers.get(this.settings.activeProvider) || null;
  }

  getActiveProviderType(): ProviderType {
    return this.settings.activeProvider;
  }

  getSystemPrompt(): string {
    return this.settings.systemPrompt;
  }

  setSystemPrompt(prompt: string): void {
    this.settings.systemPrompt = prompt;
    this.saveSettings();
  }

  getBrainyMode(): 'sidebar' | 'full' {
    return this.settings.brainyMode || 'sidebar';
  }

  setBrainyMode(mode: 'sidebar' | 'full'): void {
    this.settings.brainyMode = mode;
    this.saveSettings();
    try {
      window.dispatchEvent(new CustomEvent('brainy-mode-changed', { detail: mode }));
    } catch {
      // ignore event errors
    }
  }

  // Provider operations
  getProvider(type: ProviderType): AIProvider | null {
    return this.providers.get(type) || null;
  }

  getProviderConfig(type: ProviderType) {
    return PROVIDER_CONFIGS[type];
  }

  getAllProviderConfigs() {
    return PROVIDER_CONFIGS;
  }

  async listModels(type?: ProviderType): Promise<string[]> {
    const providerType = type || this.settings.activeProvider;
    const provider = this.providers.get(providerType);
    if (!provider) return [];

    try {
      return await provider.listModels();
    } catch (error) {
      console.error(`Failed to list models for ${providerType}:`, error);
      return [];
    }
  }

  async generate(options: Omit<GenerateOptions, 'system'> & { system?: string }): Promise<string> {
    const provider = this.getActiveProvider();
    if (!provider) throw new Error('No active provider');

    return provider.generate({
      ...options,
      system: options.system || this.settings.systemPrompt,
    });
  }

  async streamGenerate(
    options: Omit<GenerateOptions, 'system'> & { system?: string },
    callbacks: StreamCallbacks
  ): Promise<() => void> {
    const provider = this.getActiveProvider();
    if (!provider) throw new Error('No active provider');

    return provider.streamGenerate(
      {
        ...options,
        system: options.system || this.settings.systemPrompt,
      },
      callbacks
    );
  }

  isConfigured(): boolean {
    const provider = this.getActiveProvider();
    return provider?.isConfigured() ?? false;
  }
}

// Export singleton instance
export const aiService = new AIService();

// Re-export types
export * from './types';
