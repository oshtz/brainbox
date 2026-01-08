/**
 * Tool Executor
 *
 * Executes brainy tool calls by mapping them to Tauri backend commands.
 * Handles vault key management and permission checks.
 */

import { invoke } from '@tauri-apps/api/core';
import { BackendSearchResult, BackendVault, BackendVaultItem } from '../../types';
import { ToolCall, ToolResult, DESTRUCTIVE_TOOLS } from './tools';

export interface VaultInfo {
  id: string;
  title: string;
  has_password?: boolean;
}

export interface ToolExecutorConfig {
  /** Function to get vault key (prompts user if needed) */
  getVaultKey: (vaultId: string, vaultName?: string, hasPassword?: boolean) => Promise<number[]>;
  /** Function to get vault info by ID */
  getVaultInfo: (vaultId: string) => VaultInfo | undefined;
  /** Function to get all vaults */
  getVaults: () => VaultInfo[];
  /** Function to request user confirmation for destructive actions */
  confirmAction?: (message: string) => Promise<boolean>;
  /** Callback when data changes (for UI refresh) */
  onDataChange?: () => void;
}

type BackendVaultListEntry = BackendVault & {
  item_count?: number | null;
};

type BackendItemMetadata = {
  item_type?: string;
  created_at?: string;
  updated_at?: string;
};

type BackendVaultItemListEntry = Pick<BackendVaultItem, 'id' | 'title'> &
  Partial<Pick<BackendVaultItem, 'summary' | 'created_at' | 'updated_at'>> & {
    content?: string | null;
    content_preview?: string | null;
    metadata?: BackendItemMetadata;
  };

type BackendCreateItemResponse = Pick<BackendVaultItem, 'id' | 'title'>;

type BackendSearchResultRow = Pick<BackendSearchResult, 'id' | 'title' | 'score'> & {
  content?: string | null;
  snippet?: string | null;
};

export class ToolExecutor {
  private config: ToolExecutorConfig;

  constructor(config: ToolExecutorConfig) {
    this.config = config;
  }

  /**
   * Execute a tool call and return the result
   */
  async execute(toolCall: ToolCall): Promise<ToolResult> {
    const { id, name, arguments: args } = toolCall;

    try {
      // Check if destructive action needs confirmation
      if (DESTRUCTIVE_TOOLS.has(name)) {
        const confirmed = await this.config.confirmAction?.(
          `brainy wants to execute "${name}". Allow this action?`
        );
        if (confirmed === false) {
          return {
            tool_use_id: id,
            success: false,
            error: 'Action cancelled by user',
          };
        }
      }

      const result = await this.executeInternal(name, args);

      // Notify UI of data changes for write operations
      if (this.isWriteOperation(name)) {
        this.config.onDataChange?.();
      }

      return {
        tool_use_id: id,
        success: true,
        result,
      };
    } catch (error) {
      return {
        tool_use_id: id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private isWriteOperation(name: string): boolean {
    return [
      'create_vault',
      'rename_vault',
      'create_item',
      'update_item_title',
      'update_item_content',
      'move_item',
      'delete_item',
      'summarize_item',
    ].includes(name);
  }

  private async executeInternal(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      // === Vault Operations ===
      case 'list_vaults': {
        const vaults = await invoke<BackendVaultListEntry[]>('list_vaults');
        return vaults.map((v) => ({
          id: String(v.id),
          name: v.name,
          item_count: v.item_count || 0,
          has_password: v.has_password ?? false,
        }));
      }

      case 'create_vault': {
        const result = await invoke<BackendVault>('create_vault', {
          name: args.name as string,
          password: '',
          hasPassword: false,
        });
        return {
          id: String(result.id),
          name: result.name,
          message: `Created vault "${result.name}"`,
        };
      }

      case 'rename_vault': {
        await invoke('rename_vault', {
          vaultId: Number(args.vault_id),
          name: args.name as string,
        });
        return { success: true, message: `Renamed vault to "${args.name}"` };
      }

      // === Item Read Operations ===
      case 'list_items': {
        const vaultId = args.vault_id as string;
        const vaultInfo = this.config.getVaultInfo(vaultId);
        const key = await this.config.getVaultKey(
          vaultId,
          vaultInfo?.title,
          vaultInfo?.has_password
        );

        const items = await invoke<BackendVaultItemListEntry[]>('list_vault_items', {
          vaultId: Number(vaultId),
          key,
        });

        return items.map((item) => ({
          id: String(item.id),
          title: item.title,
          type: item.metadata?.item_type || 'note',
          summary: item.summary || null,
          created_at: item.metadata?.created_at ?? item.created_at,
          updated_at: item.metadata?.updated_at ?? item.updated_at,
        }));
      }

      case 'get_item': {
        const itemId = args.item_id as string;
        // We need to find which vault this item belongs to
        // For now, try to get the item - the backend should handle this
        const vaults = this.config.getVaults();

        for (const vault of vaults) {
          try {
            const key = await this.config.getVaultKey(
              vault.id,
              vault.title,
              vault.has_password
            );
            const item = await invoke<BackendVaultItemListEntry | null>('get_vault_item', {
              itemId: Number(itemId),
              key,
            });
            if (item) {
              return {
                id: String(item.id),
                vault_id: vault.id,
                title: item.title,
                content: item.content || item.content_preview,
                type: item.metadata?.item_type || 'note',
                summary: item.summary || null,
                created_at: item.metadata?.created_at ?? item.created_at,
                updated_at: item.metadata?.updated_at ?? item.updated_at,
              };
            }
          } catch {
            // Item not in this vault, continue
          }
        }
        throw new Error(`Item ${itemId} not found`);
      }

      case 'search_items': {
        const query = args.query as string;
        try {
          const results = await invoke<BackendSearchResultRow[]>('search', {
            query,
            limit: 20,
          });
          return results.map((r) => ({
            id: r.id,
            title: r.title,
            snippet: (r.snippet ?? r.content ?? '').slice(0, 200),
            score: r.score,
          }));
        } catch {
          // Fallback: search manually through vaults
          return this.manualSearch(query);
        }
      }

      // === Item Write Operations ===
      case 'create_item': {
        const vaultId = args.vault_id as string;
        const vaultInfo = this.config.getVaultInfo(vaultId);
        const key = await this.config.getVaultKey(
          vaultId,
          vaultInfo?.title,
          vaultInfo?.has_password
        );

        const result = await invoke<BackendCreateItemResponse>('add_vault_item', {
          vaultId: Number(vaultId),
          title: args.title as string,
          content: args.content as string,
          key,
        });

        return {
          id: String(result.id),
          title: result.title,
          message: `Created item "${result.title}" in vault`,
        };
      }

      case 'update_item_title': {
        await invoke('update_vault_item_title', {
          itemId: Number(args.item_id),
          title: args.title as string,
        });
        return { success: true, message: `Updated title to "${args.title}"` };
      }

      case 'update_item_content': {
        const itemId = args.item_id as string;
        const content = args.content as string;

        // Find the vault for this item to get the key
        const vaults = this.config.getVaults();
        for (const vault of vaults) {
          try {
            const key = await this.config.getVaultKey(
              vault.id,
              vault.title,
              vault.has_password
            );
            await invoke('update_vault_item_content', {
              itemId: Number(itemId),
              content,
              key,
            });
            return { success: true, message: 'Updated item content' };
          } catch {
            // Not in this vault, continue
          }
        }
        throw new Error(`Could not update item ${itemId}`);
      }

      case 'move_item': {
        await invoke('move_vault_item', {
          itemId: Number(args.item_id),
          targetVaultId: Number(args.target_vault_id),
        });
        return { success: true, message: 'Moved item to target vault' };
      }

      case 'delete_item': {
        await invoke('delete_vault_item', {
          itemId: Number(args.item_id),
        });
        return { success: true, message: 'Deleted item' };
      }

      // === Web Tools ===
      case 'fetch_webpage': {
        const text = await invoke<string>('fetch_url_text', {
          url: args.url as string,
        });
        return {
          url: args.url,
          content: text.slice(0, 10000), // Limit response size
          truncated: text.length > 10000,
        };
      }

      case 'fetch_youtube_transcript': {
        const transcript = await invoke<string | null>('fetch_youtube_transcript', {
          url: args.url as string,
        });
        if (!transcript) {
          return { url: args.url, transcript: null, message: 'No transcript available' };
        }
        return {
          url: args.url,
          transcript: transcript.slice(0, 15000),
          truncated: transcript.length > 15000,
        };
      }

      // === Summarization ===
      case 'summarize_item': {
        // This would trigger the AI summarization flow
        // For now, just update that a summary was requested
        return {
          item_id: args.item_id,
          message: 'Summary generation requested. This will be processed separately.',
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Manual search fallback when search index is unavailable
   */
  private async manualSearch(query: string): Promise<unknown[]> {
    interface SearchResultItem {
      id: string;
      vault_id: string;
      vault_name: string;
      title: string;
      snippet: string;
    }
    const results: SearchResultItem[] = [];
    const queryLower = query.toLowerCase();
    const vaults = this.config.getVaults();

    interface ManualSearchItem {
      id: number;
      title?: string;
      content_preview?: string;
      summary?: string;
    }

    for (const vault of vaults) {
      try {
        const key = await this.config.getVaultKey(
          vault.id,
          vault.title,
          vault.has_password
        );
        const items = await invoke<ManualSearchItem[]>('list_vault_items', {
          vaultId: Number(vault.id),
          key,
        });

        for (const item of items) {
          const titleMatch = item.title?.toLowerCase().includes(queryLower);
          const contentMatch = item.content_preview?.toLowerCase().includes(queryLower);
          const summaryMatch = item.summary?.toLowerCase().includes(queryLower);

          if (titleMatch || contentMatch || summaryMatch) {
            results.push({
              id: String(item.id),
              vault_id: vault.id,
              vault_name: vault.title,
              title: item.title ?? '',
              snippet: (item.content_preview?.slice(0, 200) ?? item.summary?.slice(0, 200) ?? ''),
            });
          }
        }
      } catch {
        // Skip vaults we can't access
      }
    }

    return results.slice(0, 20);
  }
}
