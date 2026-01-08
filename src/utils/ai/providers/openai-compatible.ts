/**
 * OpenAI-Compatible Provider Base
 *
 * Base implementation for providers that use the OpenAI API format.
 * Used by: LM Studio, OpenRouter, OpenAI
 */

import {
  AIProvider,
  ProviderConfig,
  ProviderSettings,
  ProviderType,
  GenerateOptions,
  StreamCallbacks,
  GenerateWithToolsOptions,
  ToolResponse,
  Message,
  TextContent,
  ToolUseContent,
  ToolResultContent,
  PROVIDER_CONFIGS,
} from '../types';
import { ToolCall, toOpenAITools } from '../tools';

// OpenAI API types
interface OpenAIMessage {
  role: string;
  content?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIAssistantMessage {
  role: 'assistant';
  content?: string;
  tool_calls?: OpenAIToolCall[];
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly type: ProviderType;
  readonly config: ProviderConfig;
  protected settings: ProviderSettings;

  constructor(type: ProviderType, settings: ProviderSettings) {
    this.type = type;
    this.config = PROVIDER_CONFIGS[type];
    this.settings = settings;
  }

  updateSettings(settings: ProviderSettings): void {
    this.settings = settings;
  }

  isConfigured(): boolean {
    const hasModel = !!this.settings.model;
    const hasApiKey = !this.config.requiresApiKey || !!this.settings.apiKey;
    return hasModel && hasApiKey;
  }

  supportsNativeTools(): boolean {
    // OpenAI and OpenRouter support tools, LM Studio does not
    return this.type === 'openai' || this.type === 'openrouter';
  }

  protected getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.settings.apiKey) {
      headers['Authorization'] = `Bearer ${this.settings.apiKey}`;
    }

    // OpenRouter specific headers
    if (this.type === 'openrouter') {
      headers['HTTP-Referer'] = 'https://brainbox.app';
      headers['X-Title'] = 'brainbox';
    }

    return headers;
  }

  /**
   * Convert our message format to OpenAI format
   */
  protected formatMessagesForOpenAI(messages: Message[], system?: string): OpenAIMessage[] {
    const formatted: OpenAIMessage[] = [];

    if (system) {
      formatted.push({ role: 'system', content: system });
    }

    for (const msg of messages) {
      if (msg.role === 'user') {
        formatted.push({
          role: 'user',
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        });
      } else if (msg.role === 'assistant') {
        if (Array.isArray(msg.content)) {
          // Assistant message with potential tool calls
          const textParts = (msg.content as (TextContent | ToolUseContent)[])
            .filter((c): c is TextContent => c.type === 'text')
            .map((c) => c.text)
            .join('');

          const toolCalls: OpenAIToolCall[] = (msg.content as (TextContent | ToolUseContent)[])
            .filter((c): c is ToolUseContent => c.type === 'tool_use')
            .map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: {
                name: c.name,
                arguments: JSON.stringify(c.input),
              },
            }));

          const assistantMsg: OpenAIAssistantMessage = { role: 'assistant' };
          if (textParts) assistantMsg.content = textParts;
          if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;

          formatted.push(assistantMsg);
        } else {
          formatted.push({
            role: 'assistant',
            content: msg.content as string,
          });
        }
      } else if (msg.role === 'tool_result') {
        // Tool results in OpenAI format
        const results = msg.content as ToolResultContent[];
        for (const result of results) {
          formatted.push({
            role: 'tool',
            tool_call_id: result.tool_use_id,
            content: result.content,
          });
        }
      }
    }

    return formatted;
  }

  /**
   * Extract tool calls from OpenAI response
   */
  protected extractToolCallsFromOpenAI(message: OpenAIAssistantMessage | undefined): ToolCall[] {
    if (!message?.tool_calls || !Array.isArray(message.tool_calls)) {
      return [];
    }

    return message.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}'),
    }));
  }

  /**
   * Generate with tool calling support
   */
  async generateWithTools(options: GenerateWithToolsOptions): Promise<ToolResponse> {
    const model = options.model || this.settings.model;
    if (!model) throw new Error('No model selected');

    const messages = this.formatMessagesForOpenAI(options.messages, options.system);

    const response = await fetch(`${this.settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model,
        messages,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature ?? 0.7,
        tools: toOpenAITools(options.tools),
        tool_choice: 'auto',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    const message = choice?.message;

    const textContent = message?.content || '';
    const toolCalls = this.extractToolCallsFromOpenAI(message);

    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' = 'end_turn';
    if (choice?.finish_reason === 'tool_calls') {
      stopReason = 'tool_use';
    } else if (choice?.finish_reason === 'length') {
      stopReason = 'max_tokens';
    }

    return {
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason,
      raw: data,
    };
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.settings.baseUrl}/models`, {
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }

      const data = await response.json();

      // Handle different response formats
      if (Array.isArray(data)) {
        return data.map((m: { id?: string; name?: string }) => m.id || m.name || '');
      }
      if (data.data && Array.isArray(data.data)) {
        return data.data.map((m: { id?: string; name?: string }) => m.id || m.name || '');
      }

      return [];
    } catch (error) {
      console.error(`Failed to list ${this.config.name} models:`, error);
      return [];
    }
  }

  async generate(options: GenerateOptions): Promise<string> {
    const model = options.model || this.settings.model;
    if (!model) throw new Error('No model selected');

    const messages = [];
    if (options.system) {
      messages.push({ role: 'system', content: options.system });
    }
    messages.push({ role: 'user', content: options.prompt });

    const response = await fetch(`${this.settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model,
        messages,
        max_tokens: options.maxTokens || 2048,
        temperature: options.temperature ?? 0.7,
        stream: false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  async streamGenerate(
    options: GenerateOptions,
    callbacks: StreamCallbacks
  ): Promise<() => void> {
    const model = options.model || this.settings.model;
    if (!model) throw new Error('No model selected');

    const messages = [];
    if (options.system) {
      messages.push({ role: 'system', content: options.system });
    }
    messages.push({ role: 'user', content: options.prompt });

    let aborted = false;
    const controller = new AbortController();

    (async () => {
      try {
        const response = await fetch(`${this.settings.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify({
            model,
            messages,
            max_tokens: options.maxTokens || 2048,
            temperature: options.temperature ?? 0.7,
            stream: true,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`API error: ${response.status} - ${error}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body');

        const decoder = new TextDecoder();
        let buffer = '';

        while (!aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]') continue;
            if (!trimmed.startsWith('data: ')) continue;

            try {
              const json = JSON.parse(trimmed.slice(6));
              const content = json.choices?.[0]?.delta?.content;
              if (content && callbacks.onToken) {
                callbacks.onToken(content);
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }

        if (!aborted) callbacks.onDone?.();
      } catch (error) {
        if (!aborted) {
          callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      }
    })();

    return () => {
      aborted = true;
      controller.abort();
    };
  }
}

// Specific provider classes
export class LMStudioProvider extends OpenAICompatibleProvider {
  constructor(settings: ProviderSettings) {
    super('lmstudio', settings);
  }

  async listModels(): Promise<string[]> {
    // LM Studio uses a simpler model listing
    try {
      const response = await fetch(`${this.settings.baseUrl}/models`, {
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        // LM Studio might not have the models endpoint
        return ['local-model'];
      }

      const data = await response.json();
      if (data.data && Array.isArray(data.data)) {
        return data.data.map((m: { id: string }) => m.id);
      }
      return ['local-model'];
    } catch {
      return ['local-model'];
    }
  }
}

export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(settings: ProviderSettings) {
    super('openrouter', settings);
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }

      const data = await response.json();
      if (data.data && Array.isArray(data.data)) {
        // Sort by name and return IDs
        return data.data
          .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))
          .map((m: { id: string }) => m.id);
      }
      return [];
    } catch (error) {
      console.error('Failed to list OpenRouter models:', error);
      return [];
    }
  }
}

export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(settings: ProviderSettings) {
    super('openai', settings);
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.settings.baseUrl}/models`, {
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }

      const data = await response.json();
      if (data.data && Array.isArray(data.data)) {
        // Filter to only chat models
        return data.data
          .filter((m: { id: string }) =>
            m.id.includes('gpt') || m.id.includes('o1') || m.id.includes('chatgpt')
          )
          .map((m: { id: string }) => m.id)
          .sort();
      }
      return [];
    } catch (error) {
      console.error('Failed to list OpenAI models:', error);
      // Return common models as fallback
      return ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'];
    }
  }
}
