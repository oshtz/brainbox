/**
 * Anthropic Provider
 *
 * Integration with Anthropic's Claude models with native tool calling support.
 */

import {
  AIProvider,
  ProviderConfig,
  ProviderSettings,
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
import { ToolCall, toAnthropicTools } from '../tools';

// Anthropic API response types
interface AnthropicTextContent {
  type: 'text';
  text: string;
}

interface AnthropicToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

type AnthropicContentBlock = AnthropicTextContent | AnthropicToolUseContent | AnthropicToolResultContent;

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

export class AnthropicProvider implements AIProvider {
  readonly type = 'anthropic' as const;
  readonly config: ProviderConfig = PROVIDER_CONFIGS.anthropic;
  private settings: ProviderSettings;

  constructor(settings: ProviderSettings) {
    this.settings = settings;
  }

  updateSettings(settings: ProviderSettings): void {
    this.settings = settings;
  }

  isConfigured(): boolean {
    return !!this.settings.apiKey && !!this.settings.model;
  }

  supportsNativeTools(): boolean {
    return true;
  }

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.settings.apiKey || '',
      'anthropic-version': '2023-06-01',
    };
  }

  async listModels(): Promise<string[]> {
    // Anthropic doesn't have a models endpoint, return known models
    return [
      'claude-sonnet-4-20250514',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307',
    ];
  }

  /**
   * Convert our message format to Anthropic's format
   */
  private formatMessagesForAnthropic(messages: Message[]): AnthropicMessage[] {
    return messages.map((msg): AnthropicMessage => {
      if (msg.role === 'tool_result') {
        // Tool results need special formatting
        const content = msg.content as ToolResultContent[];
        return {
          role: 'user',
          content: content.map((c) => ({
            type: 'tool_result',
            tool_use_id: c.tool_use_id,
            content: c.content,
            is_error: c.is_error,
          })),
        };
      }

      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        // Assistant messages with tool use
        return {
          role: 'assistant',
          content: (msg.content as (TextContent | ToolUseContent)[]).map((c) => {
            if (c.type === 'text') {
              return { type: 'text', text: c.text };
            }
            if (c.type === 'tool_use') {
              return {
                type: 'tool_use',
                id: c.id,
                name: c.name,
                input: c.input,
              };
            }
            return c;
          }),
        };
      }

      // Simple text message
      return {
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      };
    });
  }

  /**
   * Extract text content from Anthropic response
   */
  private extractTextFromResponse(content: AnthropicContentBlock[]): string {
    return content
      .filter((c): c is AnthropicTextContent => c.type === 'text')
      .map((c) => c.text)
      .join('');
  }

  /**
   * Extract tool calls from Anthropic response
   */
  private extractToolCallsFromResponse(content: AnthropicContentBlock[]): ToolCall[] {
    return content
      .filter((c): c is AnthropicToolUseContent => c.type === 'tool_use')
      .map((c) => ({
        id: c.id,
        name: c.name,
        arguments: c.input || {},
      }));
  }

  /**
   * Generate with tool calling support
   */
  async generateWithTools(options: GenerateWithToolsOptions): Promise<ToolResponse> {
    const model = options.model || this.settings.model;
    if (!model) throw new Error('No model selected');

    const response = await fetch(`${this.settings.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model,
        max_tokens: options.maxTokens || 4096,
        system: options.system,
        messages: this.formatMessagesForAnthropic(options.messages),
        tools: toAnthropicTools(options.tools),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error: ${response.status} - ${error}`);
    }

    const data = await response.json();

    const textContent = this.extractTextFromResponse(data.content || []);
    const toolCalls = this.extractToolCallsFromResponse(data.content || []);

    return {
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason: data.stop_reason === 'tool_use' ? 'tool_use' : 'end_turn',
      raw: data,
    };
  }

  async generate(options: GenerateOptions): Promise<string> {
    const model = options.model || this.settings.model;
    if (!model) throw new Error('No model selected');

    const response = await fetch(`${this.settings.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model,
        max_tokens: options.maxTokens || 2048,
        system: options.system,
        messages: [{ role: 'user', content: options.prompt }],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.content?.[0]?.text || '';
  }

  async streamGenerate(
    options: GenerateOptions,
    callbacks: StreamCallbacks
  ): Promise<() => void> {
    const model = options.model || this.settings.model;
    if (!model) throw new Error('No model selected');

    let aborted = false;
    const controller = new AbortController();

    (async () => {
      try {
        const response = await fetch(`${this.settings.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify({
            model,
            max_tokens: options.maxTokens || 2048,
            system: options.system,
            messages: [{ role: 'user', content: options.prompt }],
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
            if (!trimmed || !trimmed.startsWith('data: ')) continue;

            try {
              const json = JSON.parse(trimmed.slice(6));

              if (json.type === 'content_block_delta') {
                const text = json.delta?.text;
                if (text && callbacks.onToken) {
                  callbacks.onToken(text);
                }
              } else if (json.type === 'message_stop') {
                break;
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
