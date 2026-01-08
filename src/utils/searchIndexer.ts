/**
 * Utility for managing search indexing operations in brainbox
 * 
 * This utility provides a consistent way to add, update, and remove
 * content from the BM25-powered search index
 */
import { invoke } from '@tauri-apps/api/core';
import { v4 as uuidv4 } from 'uuid';
import { BackendVault, BackendVaultItem } from '../types';

export interface IndexableContent {
  id?: string;
  title: string;
  content: string;
  itemType: string;
  createdAt?: Date;
  updatedAt?: Date;
  path?: string;
  tags?: string[];
}

/**
 * Add content to the search index
 * @param content The content to index
 * @returns The ID of the indexed content
 */
export async function addToIndex(content: IndexableContent): Promise<string> {
  const id = content.id || uuidv4();
  const createdAt = content.createdAt || new Date();
  const updatedAt = content.updatedAt || new Date();
  
  try {
    await invoke('index_document', {
      id,
      title: content.title,
      content: content.content,
      item_type: content.itemType,
      created_at: createdAt.toISOString(),
      updated_at: updatedAt.toISOString(),
      path: content.path,
      tags: content.tags || [],
    });
    
    return id;
  } catch (error) {
    console.error('Error adding content to search index:', error);
    throw error;
  }
}

/**
 * Update content in the search index
 * @param id The ID of the content to update
 * @param content The updated content
 */
export async function updateInIndex(id: string, content: Partial<IndexableContent>): Promise<void> {
  try {
    // First get the existing content from your storage
    // This is a placeholder - you would replace this with actual retrieval logic
    const existingContent = await getContentFromStorage(id);
    
    if (!existingContent) {
      throw new Error(`Content with ID ${id} not found in storage`);
    }
    
    // Merge existing content with updates
    const updatedContent = {
      ...existingContent,
      ...content,
      id,
      updatedAt: new Date(),
    };
    
    // Add updated content to index (this will replace the existing entry)
    await addToIndex(updatedContent);
  } catch (error) {
    console.error('Error updating content in search index:', error);
    throw error;
  }
}

/**
 * Remove content from the search index
 * @param id The ID of the content to remove
 */
export async function removeFromIndex(id: string): Promise<void> {
  try {
    await invoke('delete_document', { id });
  } catch (error) {
    console.error('Error removing content from search index:', error);
    throw error;
  }
}

/**
 * Get content from storage by ID
 * Retrieves vault item from SQLite database via Tauri backend
 * @param id The ID of the content to retrieve
 */
async function getContentFromStorage(id: string): Promise<IndexableContent | null> {
  try {
    // Parse the ID to extract vault_id and item_id
    // Expected format: "vault-{vaultId}-item-{itemId}"
    const match = id.match(/^vault-(\d+)-item-(\d+)$/);
    if (!match) {
      console.error(`Invalid ID format: ${id}. Expected format: vault-{vaultId}-item-{itemId}`);
      return null;
    }

    const [, vaultIdStr, itemIdStr] = match;
    const vaultId = parseInt(vaultIdStr, 10);
    const itemId = parseInt(itemIdStr, 10);

    // Get the vault item from the backend
    const item = await invoke<BackendVaultItem | null>('get_vault_item', {
      vaultId,
      itemId
    });

    if (!item) {
      return null;
    }

    // Convert to IndexableContent format
    return {
      id,
      title: item.title || '',
      content: item.content || '',
      itemType: 'vault_item',
      createdAt: item.created_at ? new Date(item.created_at) : new Date(),
      updatedAt: item.updated_at ? new Date(item.updated_at) : new Date(),
      path: `vault/${vaultId}/item/${itemId}`,
      tags: [],
    };
  } catch (error) {
    console.error(`Error retrieving content from storage for ID ${id}:`, error);
    return null;
  }
}

/**
 * Index multiple content items in batch
 * @param items Array of content items to index
 * @returns Array of generated/provided IDs
 */
export async function batchAddToIndex(items: IndexableContent[]): Promise<string[]> {
  const results: string[] = [];
  
  for (const item of items) {
    const id = await addToIndex(item);
    results.push(id);
  }
  
  return results;
}

/**
 * Rebuild the entire search index from scratch
 * Retrieves all vaults and their items from storage and reindexes them
 */
export async function rebuildIndex(): Promise<void> {
  try {
    console.log('Starting search index rebuild...');
    
    // Get all vaults from the backend
    const vaults = await invoke<BackendVault[]>('list_vaults');
    
    if (!vaults || vaults.length === 0) {
      console.log('No vaults found. Index rebuild complete.');
      return;
    }

    let totalIndexed = 0;
    
    // For each vault, get all items and index them
    for (const vault of vaults) {
      try {
        const items = await invoke<BackendVaultItem[]>('list_vault_items', {
          vaultId: vault.id
        });
        
        if (!items || items.length === 0) {
          continue;
        }

        // Index each item
        for (const item of items) {
          try {
            const indexableContent: IndexableContent = {
              id: `vault-${vault.id}-item-${item.id}`,
              title: item.title || '',
              content: item.content || '',
              itemType: 'vault_item',
              createdAt: item.created_at ? new Date(item.created_at) : new Date(),
              updatedAt: item.updated_at ? new Date(item.updated_at) : new Date(),
              path: `vault/${vault.id}/item/${item.id}`,
              tags: [],
            };

            await addToIndex(indexableContent);
            totalIndexed++;
          } catch (itemError) {
            console.error(`Error indexing item ${item.id} from vault ${vault.id}:`, itemError);
            // Continue with next item
          }
        }
      } catch (vaultError) {
        console.error(`Error processing vault ${vault.id}:`, vaultError);
        // Continue with next vault
      }
    }
    
    console.log(`Search index rebuild complete. Indexed ${totalIndexed} items from ${vaults.length} vaults.`);
  } catch (error) {
    console.error('Error rebuilding search index:', error);
    throw error;
  }
}
