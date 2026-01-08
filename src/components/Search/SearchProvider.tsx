import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';

// Import the SearchResult interface
import { SearchResult } from './SearchBar';

interface SearchContextType {
  search: (query: string, limit?: number) => Promise<SearchResult[]>;
  indexDocument: (params: IndexDocumentParams) => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
  isSearching: boolean;
  lastResults: SearchResult[];
  lastQuery: string;
}

interface IndexDocumentParams {
  id: string;
  title: string;
  content: string;
  itemType: string;
  createdAt: string;
  updatedAt: string;
  path?: string;
  tags: string[];
}

// Create context with default values
const SearchContext = createContext<SearchContextType>({
  search: async () => [],
  indexDocument: async () => {},
  deleteDocument: async () => {},
  isSearching: false,
  lastResults: [],
  lastQuery: '',
});

// Custom hook to use the search context
export const useSearch = () => useContext(SearchContext);

interface SearchProviderProps {
  children: ReactNode;
}

export const SearchProvider: React.FC<SearchProviderProps> = ({ children }) => {
  const [isSearching, setIsSearching] = useState(false);
  const [lastResults, setLastResults] = useState<SearchResult[]>([]);
  const [lastQuery, setLastQuery] = useState('');

  // Search function using BM25 algorithm via Tauri/Rust backend
  const search = useCallback(async (query: string, limit = 20): Promise<SearchResult[]> => {
    if (!query.trim()) {
      setLastResults([]);
      setLastQuery('');
      return [];
    }

    setIsSearching(true);
    setLastQuery(query);

    try {
      const results: SearchResult[] = await invoke('search', {
        query,
        limit,
      });
      
      setLastResults(results);
      return results;
    } catch (error) {
      console.error('Search error:', error);
      return [];
    } finally {
      setIsSearching(false);
    }
  }, []);

  // Add document to search index
  const indexDocument = useCallback(async ({
    id,
    title,
    content,
    itemType,
    createdAt,
    updatedAt,
    path,
    tags,
  }: IndexDocumentParams): Promise<void> => {
    try {
      await invoke('index_document', {
        id,
        title,
        content,
        item_type: itemType,
        created_at: createdAt,
        updated_at: updatedAt,
        path,
        tags,
      });
    } catch (error) {
      console.error('Error indexing document:', error);
      throw error;
    }
  }, []);

  // Delete document from search index
  const deleteDocument = useCallback(async (id: string): Promise<void> => {
    try {
      await invoke('delete_document', { id });
    } catch (error) {
      console.error('Error deleting document from index:', error);
      throw error;
    }
  }, []);

  // Provide the search functionality to all children
  return (
    <SearchContext.Provider
      value={{
        search,
        indexDocument,
        deleteDocument,
        isSearching,
        lastResults,
        lastQuery,
      }}
    >
      {children}
    </SearchContext.Provider>
  );
};

export default SearchProvider;
