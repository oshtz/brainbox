/**
 * Google AI Provider
 *
 * Integration with Google's Gemini models with function calling support.
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
import { ToolCall, ToolDefinition } from '../tools';

// Google Gemini API types
interface GoogleTextPart {
  text: string;
}

interface GoogleFunctionCallPart {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
  };
}

interface GoogleFunctionResponsePart {
  functionResponse: {
    name: string;
    response: { content: string };
  };
}

type GooglePart = GoogleTextPart | GoogleFunctionCallPart | GoogleFunctionResponsePart;

interface GoogleContent {
  role: 'user' | 'model';
  parts: GooglePart[];
}

interface GoogleCandidate {
  content?: {
    parts?: GooglePart[];
  };
  finishReason?: string;
}

export class GoogleProvider implements AIProvider {
  readonly type = 'google' as const;
  readonly config: ProviderConfig = PROVIDER_CONFIGS.google;
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

  async listModels(): Promise<string[]> {
    // Return known Gemini models
    return [
      'gemini-2.0-flash-exp',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-1.5-flash-8b',
      'gemini-1.0-pro',
    ];
  }

  /**
   * Convert our tool definitions to Google's format
   */
  private toGoogleTools(tools: ToolDefinition[]) {
    return [{
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: {
          type: 'OBJECT',
          properties: Object.fromEntries(
            Object.entries(t.parameters.properties).map(([key, value]) => [
              key,
              {
                type: value.type.toUpperCase(),
                description: value.description,
                enum: value.enum,
              },
            ])
          ),
          required: t.parameters.required,
        },
      })),
    }];
  }

  /**
   * Convert our messages to Google's format
   */
  private formatMessagesForGoogle(messages: Message[], system?: string): GoogleContent[] {
    const contents: GoogleContent[] = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        // Prepend system prompt to first user message
        if (contents.length === 0 && system) {
          contents.push({
            role: 'user',
            parts: [{ text: `${system}\n\n${text}` }],
          });
        } else {
          contents.push({
            role: 'user',
            parts: [{ text }],
          });
        }
      } else if (msg.role === 'assistant') {
        if (Array.isArray(msg.content)) {
          const parts: GooglePart[] = [];
          for (const c of msg.content as (TextContent | ToolUseContent)[]) {
            if (c.type === 'text') {
              parts.push({ text: c.text });
            } else if (c.type === 'tool_use') {
              parts.push({
                functionCall: {
                  name: c.name,
                  args: c.input,
                },
              });
            }
          }
          contents.push({ role: 'model', parts });
        } else {
          contents.push({
            role: 'model',
            parts: [{ text: msg.content as string }],
          });
        }
      } else if (msg.role === 'tool_result') {
        const results = msg.content as ToolResultContent[];
        const parts: GoogleFunctionResponsePart[] = results.map((r) => ({
          functionResponse: {
            name: r.tool_use_id.split('_')[0], // Extract tool name
            response: { content: r.content },
          },
        }));
        contents.push({ role: 'user', parts });
      }
    }

    return contents;
  }

  /**
   * Extract tool calls from Google response
   */
  private extractToolCalls(candidate: GoogleCandidate | undefined): ToolCall[] {
    const toolCalls: ToolCall[] = [];
    const parts = candidate?.content?.parts || [];

    for (const part of parts) {
      if ('functionCall' in part) {
        toolCalls.push({
          id: `${part.functionCall.name}_${Date.now()}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args || {},
        });
      }
    }

    return toolCalls;
  }

  /**
   * Generate with tool calling support
   */
  async generateWithTools(options: GenerateWithToolsOptions): Promise<ToolResponse> {
    const model = options.model || this.settings.model;
    if (!model) throw new Error('No model selected');

    const url = `${this.settings.baseUrl}/models/${model}:generateContent?key=${this.settings.apiKey}`;
    const contents = this.formatMessagesForGoogle(options.messages, options.system);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        tools: this.toGoogleTools(options.tools),
        generationConfig: {
          maxOutputTokens: options.maxTokens || 4096,
          temperature: options.temperature ?? 0.7,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const candidate: GoogleCandidate | undefined = data.candidates?.[0];

    // Extract text content
    const parts: GooglePart[] = candidate?.content?.parts || [];
    const textParts = parts
      .filter((p): p is GoogleTextPart => 'text' in p)
      .map((p) => p.text)
      .join('');

    // Extract tool calls
    const toolCalls = this.extractToolCalls(candidate);

    const finishReason = candidate?.finishReason;
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' = 'end_turn';
    if (toolCalls.length > 0) {
      stopReason = 'tool_use';
    } else if (finishReason === 'MAX_TOKENS') {
      stopReason = 'max_tokens';
    }

    return {
      content: textParts,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason,
      raw: data,
    };
  }

  async generate(options: GenerateOptions): Promise<string> {
    const model = options.model || this.settings.model;
    if (!model) throw new Error('No model selected');

    const url = `${this.settings.baseUrl}/models/${model}:generateContent?key=${this.settings.apiKey}`;

    const contents = [];
    if (options.system) {
      contents.push({
        role: 'user',
        parts: [{ text: `System: ${options.system}\n\nUser: ${options.prompt}` }],
      });
    } else {
      contents.push({
        role: 'user',
        parts: [{ text: options.prompt }],
      });
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: {
          maxOutputTokens: options.maxTokens || 2048,
          temperature: options.temperature ?? 0.7,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  async streamGenerate(
    options: GenerateOptions,
    callbacks: StreamCallbacks
  ): Promise<() => void> {
    const model = options.model || this.settings.model;
    if (!model) throw new Error('No model selected');

    const url = `${this.settings.baseUrl}/models/${model}:streamGenerateContent?key=${this.settings.apiKey}&alt=sse`;

    const contents = [];
    if (options.system) {
      contents.push({
        role: 'user',
        parts: [{ text: `System: ${options.system}\n\nUser: ${options.prompt}` }],
      });
    } else {
      contents.push({
        role: 'user',
        parts: [{ text: options.prompt }],
      });
    }

    let aborted = false;
    const controller = new AbortController();

    (async () => {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            generationConfig: {
              maxOutputTokens: options.maxTokens || 2048,
              temperature: options.temperature ?? 0.7,
            },
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
              const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text && callbacks.onToken) {
                callbacks.onToken(text);
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
