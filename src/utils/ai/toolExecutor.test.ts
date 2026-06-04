import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockInvoke } from '../../test/setup';
import { ToolExecutor, ToolExecutorConfig } from './toolExecutor';
import { ToolCall } from './tools';

const key = Array.from({ length: 32 }, (_, index) => index);

function createExecutor(overrides: Partial<ToolExecutorConfig> = {}) {
  const config: ToolExecutorConfig = {
    getVaultKey: vi.fn().mockResolvedValue(key),
    getVaultInfo: vi.fn().mockReturnValue({
      id: '2',
      title: 'Research',
      has_password: false,
    }),
    getVaults: vi.fn().mockReturnValue([
      { id: '2', title: 'Research', has_password: false },
    ]),
    confirmAction: vi.fn().mockResolvedValue(true),
    onDataChange: vi.fn(),
    ...overrides,
  };

  return {
    executor: new ToolExecutor(config),
    config,
  };
}

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `tool-${name}`,
    name,
    arguments: args,
  };
}

describe('ToolExecutor', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('maps create_item to the backend command and refreshes data after writes', async () => {
    mockInvoke.mockResolvedValueOnce({ id: 7, title: 'New note' });
    const { executor, config } = createExecutor();

    const result = await executor.execute(toolCall('create_item', {
      vault_id: '2',
      title: 'New note',
      content: 'Body',
    }));

    expect(mockInvoke).toHaveBeenCalledWith('add_vault_item', {
      vaultId: 2,
      title: 'New note',
      content: 'Body',
      key,
    });
    expect(config.getVaultKey).toHaveBeenCalledWith('2', 'Research', false);
    expect(config.onDataChange).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      tool_use_id: 'tool-create_item',
      success: true,
      result: {
        id: '7',
        title: 'New note',
        message: 'Created item "New note" in vault',
      },
    });
  });

  it('does not invoke destructive backend commands when the user cancels', async () => {
    const { executor, config } = createExecutor({
      confirmAction: vi.fn().mockResolvedValue(false),
    });

    const result = await executor.execute(toolCall('delete_item', {
      item_id: '7',
    }));

    expect(config.confirmAction).toHaveBeenCalledWith(
      'brainy wants to execute "delete_item". Allow this action?'
    );
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result).toEqual({
      tool_use_id: 'tool-delete_item',
      success: false,
      error: 'Action cancelled by user',
    });
  });

  it('falls back to manual vault search when the backend search index is unavailable', async () => {
    mockInvoke
      .mockRejectedValueOnce(new Error('search unavailable'))
      .mockResolvedValueOnce([
        {
          id: 12,
          title: 'Research note',
          content_preview: 'Needle in the local vault',
        },
      ]);
    const { executor } = createExecutor();

    const result = await executor.execute(toolCall('search_items', {
      query: 'needle',
    }));

    expect(mockInvoke).toHaveBeenNthCalledWith(1, 'search', {
      query: 'needle',
      limit: 20,
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, 'list_vault_items', {
      vaultId: 2,
      key,
    });
    expect(result.success).toBe(true);
    expect(result.result).toEqual([
      {
        id: '12',
        vault_id: '2',
        vault_name: 'Research',
        title: 'Research note',
        snippet: 'Needle in the local vault',
      },
    ]);
  });
});
