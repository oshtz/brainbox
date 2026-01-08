import React, { useState, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import styles from './SearchBar.module.css';

export interface SearchResult {
  id: string;
  title: string;
  content_preview: string;
  score: number;
  metadata: {
    item_type: string;
    created_at: string;
    updated_at: string;
    path?: string;
    tags: string[];
  };
}

interface SearchBarProps {
  onResultSelect?: (result: SearchResult) => void;
  placeholder?: string;
  autoFocus?: boolean;
  maxResults?: number;
  className?: string;
}

const SearchBar: React.FC<SearchBarProps> = ({
  onResultSelect,
  placeholder = 'Search...',
  autoFocus = false,
  maxResults = 10,
  className = '',
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  
  // Search debounce timer
  const searchTimerRef = useRef<number | null>(null);
  
  // BM25 Search function - communicates with Rust backend
  const performSearch = async (searchQuery: string) => {
    if (!searchQuery.trim()) {
      setResults([]);
      return;
    }
    
    setIsSearching(true);
    try {
      const searchResults: SearchResult[] = await invoke('search', {
        query: searchQuery,
        limit: maxResults
      });
      
      setResults(searchResults);
    } catch (error) {
      console.error('Search error:', error);
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  };
  
  // Debounced search handler
  const handleSearchInput = (value: string) => {
    setQuery(value);
    
    // Clear any existing timer
    if (searchTimerRef.current) {
      window.clearTimeout(searchTimerRef.current);
    }
    
    // Set a new timer for 300ms debounce
    searchTimerRef.current = window.setTimeout(() => {
      performSearch(value);
    }, 300);
  };
  
  // Handle keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (results.length === 0) return;
    
    // Down arrow
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => 
        prev < results.length - 1 ? prev + 1 : prev
      );
    }
    // Up arrow
    else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => (prev > 0 ? prev - 1 : prev));
    }
    // Enter
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIndex >= 0 && selectedIndex < results.length) {
        handleResultSelect(results[selectedIndex]);
      }
    }
    // Escape
    else if (e.key === 'Escape') {
      setShowResults(false);
      inputRef.current?.blur();
    }
  };
  
  // Handle result selection
  const handleResultSelect = (result: SearchResult) => {
    if (onResultSelect) {
      onResultSelect(result);
    }
    setShowResults(false);
    setQuery('');
    setResults([]);
  };
  
  // Click outside handler to close results
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        resultsRef.current && 
        !resultsRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setShowResults(false);
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);
  
  // Scroll selected result into view
  useEffect(() => {
    if (selectedIndex >= 0 && resultsRef.current) {
      const selectedElement = resultsRef.current.children[selectedIndex] as HTMLElement;
      if (selectedElement) {
        selectedElement.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
        });
      }
    }
  }, [selectedIndex]);
  
  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) {
        window.clearTimeout(searchTimerRef.current);
      }
    };
  }, []);
  
  return (
    <div className={`${styles.searchContainer} ${className}`}>
      <div className={styles.inputWrapper}>
        <input
          ref={inputRef}
          type="text"
          className={styles.searchInput}
          placeholder={placeholder}
          value={query}
          onChange={e => handleSearchInput(e.target.value)}
          onFocus={() => setShowResults(true)}
          onKeyDown={handleKeyDown}
          autoFocus={autoFocus}
          aria-label="Search"
          aria-autocomplete="list"
          aria-controls="search-results"
          aria-expanded={showResults}
        />
        {isSearching && <div className={styles.searchingIndicator} />}
        {query && !isSearching && (
          <button
            className={styles.clearButton}
            onClick={() => {
              setQuery('');
              setResults([]);
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
          >
            {/* Monoline X icon */}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      
      {showResults && results.length > 0 && (
        <div 
          ref={resultsRef}
          className={styles.resultsContainer}
          id="search-results"
          role="listbox"
        >
          {results.map((result, index) => (
            <div
              key={result.id}
              className={`${styles.resultItem} ${
                index === selectedIndex ? styles.selected : ''
              }`}
              onClick={() => handleResultSelect(result)}
              role="option"
              aria-selected={index === selectedIndex}
            >
              <div className={styles.resultTitle}>{result.title}</div>
              <div className={styles.resultPreview}>{result.content_preview}</div>
              <div className={styles.resultMeta}>
                <span className={styles.resultType}>{result.metadata.item_type}</span>
                {result.metadata.tags.length > 0 && (
                  <div className={styles.resultTags}>
                    {result.metadata.tags.map(tag => (
                      <span key={tag} className={styles.tag}>
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default SearchBar;
