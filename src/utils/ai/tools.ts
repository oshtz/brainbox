/**
 * brainy Tool Definitions
 *
 * Defines the tools available to brainy for performing actions in the app.
 * These follow the OpenAI/Anthropic function calling schema.
 */

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
  items?: { type: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  tool_use_id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

/**
 * All tools available to brainy
 */
export const BRAINY_TOOLS: ToolDefinition[] = [
  // === Vault Operations ===
  {
    name: 'list_vaults',
    description: 'List all vaults the user has. Returns vault IDs, names, and item counts.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'create_vault',
    description: 'Create a new vault to organize items.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name for the new vault',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'rename_vault',
    description: 'Rename an existing vault.',
    parameters: {
      type: 'object',
      properties: {
        vault_id: {
          type: 'string',
          description: 'ID of the vault to rename',
        },
        name: {
          type: 'string',
          description: 'New name for the vault',
        },
      },
      required: ['vault_id', 'name'],
    },
  },

  // === Item Read Operations ===
  {
    name: 'list_items',
    description: 'List all items in a specific vault. Returns item IDs, titles, types, and summaries.',
    parameters: {
      type: 'object',
      properties: {
        vault_id: {
          type: 'string',
          description: 'ID of the vault to list items from',
        },
      },
      required: ['vault_id'],
    },
  },
  {
    name: 'get_item',
    description: 'Get full details of a specific item including its content.',
    parameters: {
      type: 'object',
      properties: {
        item_id: {
          type: 'string',
          description: 'ID of the item to retrieve',
        },
      },
      required: ['item_id'],
    },
  },
  {
    name: 'search_items',
    description: 'Search across all vault items by keyword. Searches titles, content, and summaries.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to find matching items',
        },
      },
      required: ['query'],
    },
  },

  // === Item Write Operations ===
  {
    name: 'create_item',
    description: 'Create a new note or URL item in a vault.',
    parameters: {
      type: 'object',
      properties: {
        vault_id: {
          type: 'string',
          description: 'ID of the vault to create the item in',
        },
        title: {
          type: 'string',
          description: 'Title for the new item',
        },
        content: {
          type: 'string',
          description: 'Content of the note, or URL if creating a link',
        },
        item_type: {
          type: 'string',
          enum: ['note', 'url'],
          description: 'Type of item to create',
        },
      },
      required: ['vault_id', 'title', 'content', 'item_type'],
    },
  },
  {
    name: 'update_item_title',
    description: 'Update the title of an existing item.',
    parameters: {
      type: 'object',
      properties: {
        item_id: {
          type: 'string',
          description: 'ID of the item to update',
        },
        title: {
          type: 'string',
          description: 'New title for the item',
        },
      },
      required: ['item_id', 'title'],
    },
  },
  {
    name: 'update_item_content',
    description: 'Update the content of an existing item.',
    parameters: {
      type: 'object',
      properties: {
        item_id: {
          type: 'string',
          description: 'ID of the item to update',
        },
        content: {
          type: 'string',
          description: 'New content for the item',
        },
      },
      required: ['item_id', 'content'],
    },
  },
  {
    name: 'move_item',
    description: 'Move an item to a different vault.',
    parameters: {
      type: 'object',
      properties: {
        item_id: {
          type: 'string',
          description: 'ID of the item to move',
        },
        target_vault_id: {
          type: 'string',
          description: 'ID of the destination vault',
        },
      },
      required: ['item_id', 'target_vault_id'],
    },
  },
  {
    name: 'delete_item',
    description: 'Delete an item permanently. Use with caution.',
    parameters: {
      type: 'object',
      properties: {
        item_id: {
          type: 'string',
          description: 'ID of the item to delete',
        },
      },
      required: ['item_id'],
    },
  },

  // === Web Tools ===
  {
    name: 'fetch_webpage',
    description: 'Fetch and extract text content from a webpage URL.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL of the webpage to fetch',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'fetch_youtube_transcript',
    description: 'Get the transcript/captions from a YouTube video.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'YouTube video URL',
        },
      },
      required: ['url'],
    },
  },

  // === Summarization ===
  {
    name: 'summarize_item',
    description: 'Generate or regenerate the AI summary for an item.',
    parameters: {
      type: 'object',
      properties: {
        item_id: {
          type: 'string',
          description: 'ID of the item to summarize',
        },
      },
      required: ['item_id'],
    },
  },
];

/**
 * Tools that require user confirmation before execution
 */
export const DESTRUCTIVE_TOOLS = new Set([
  'delete_item',
  'delete_vault',
]);

/**
 * Tools that modify data (for UI indication)
 */
export const WRITE_TOOLS = new Set([
  'create_vault',
  'rename_vault',
  'create_item',
  'update_item_title',
  'update_item_content',
  'move_item',
  'delete_item',
  'summarize_item',
]);

/**
 * Generate tool definitions in Anthropic format
 */
export function toAnthropicTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

/**
 * Generate tool definitions in OpenAI format
 */
export function toOpenAITools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Generate a short tool summary list for system prompts
 */
export function toToolSummary(tools: ToolDefinition[]): string {
  return tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
}

/**
 * Generate prompt-based tool description for models without native support
 */
export function toPromptTools(tools: ToolDefinition[]): string {
  const toolDescriptions = tools.map((t) => {
    const params = Object.entries(t.parameters.properties)
      .map(([name, prop]) => {
        const required = t.parameters.required.includes(name) ? ' (required)' : ' (optional)';
        const enumStr = prop.enum ? ` [${prop.enum.join(', ')}]` : '';
        return `    - ${name}: ${prop.description}${enumStr}${required}`;
      })
      .join('\n');
    return `- ${t.name}: ${t.description}\n  Parameters:\n${params || '    (none)'}`;
  });

  return `You have access to the following tools to help the user:

${toolDescriptions.join('\n\n')}

To use a tool, respond with this EXACT format (you can include text before or after):
<tool_call>
{"name": "tool_name", "arguments": {"param1": "value1", "param2": "value2"}}
</tool_call>

You can make multiple tool calls in one response. After each tool execution, you'll receive the result and can continue.

If you don't need to use a tool, just respond normally without the <tool_call> tags.`;
}
