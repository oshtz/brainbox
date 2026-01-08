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

const SETTINGS_KEY = 'brainbox-ai-settings';

class AIService {
  private settings: AISettings;
  private providers: Map<ProviderType, AIProvider> = new Map();

  constructor() {
    this.settings = this.loadSettings();
    this.initializeProviders();
  }

  private loadSettings(): AISettings {
    try {
      const saved = localStorage.getItem(SETTINGS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        // Merge with defaults to handle new providers
        const defaults = getDefaultSettings();
        return {
          ...defaults,
          ...parsed,
          providers: {
            ...defaults.providers,
            ...parsed.providers,
          },
        };
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
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch (error) {
      console.error('Failed to save AI settings:', error);
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
