import { useState, useEffect, useRef, useCallback } from 'react';

// Debounce hook
function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

// URL detection
export function isUrl(str) {
  return (
    str.startsWith('http://') ||
    str.startsWith('https://') ||
    str.includes('youtube.com') ||
    str.includes('youtu.be') ||
    str.includes('spotify.com')
  );
}

/**
 * useTrackSearch - encapsulates the search bar state, debounced YouTube
 * search, keyboard navigation, and submit/add handlers for the CenterPanel.
 */
export function useTrackSearch({ addToQueue }) {
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [isSearching, setIsSearching] = useState(false);
  const inputRef = useRef(null);

  const debouncedQuery = useDebounce(query, 400);

  // Fetch search results
  useEffect(() => {
    const fetchResults = async () => {
      if (!debouncedQuery || debouncedQuery.length < 2 || isUrl(debouncedQuery)) {
        setSearchResults([]);
        setSearchLoading(false);
        if (!debouncedQuery) setIsSearching(false);
        return;
      }

      try {
        setSearchLoading(true);
        const response = await fetch(
          `/api/queue/search?q=${encodeURIComponent(debouncedQuery)}&limit=5`,
          { credentials: 'include' }
        );
        if (response.ok) {
          const data = await response.json();
          setSearchResults(data.results || []);
        }
      } catch (err) {
        console.error('Search error:', err);
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    };

    fetchResults();
  }, [debouncedQuery]);

  // Handle adding a track
  const handleAdd = useCallback(
    (urlOrQuery) => {
      addToQueue?.(urlOrQuery);
    },
    [addToQueue]
  );

  // Handle search input change
  const handleInputChange = (e) => {
    const val = e.target.value;
    setQuery(val);
    if (val.trim()) {
      setIsSearching(true);
      setSearchLoading(true);
    } else {
      setIsSearching(false);
      setSearchResults([]);
    }
  };

  // Keyboard navigation
  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      setQuery('');
      setIsSearching(false);
      setSearchResults([]);
      setHighlightedIndex(-1);
      inputRef.current?.blur();
      return;
    }

    if (!isSearching || searchResults.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex((prev) => (prev < searchResults.length - 1 ? prev + 1 : 0));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : searchResults.length - 1));
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightedIndex >= 0 && searchResults[highlightedIndex]) {
          handleAdd(searchResults[highlightedIndex].url);
          setQuery('');
          setIsSearching(false);
          setSearchResults([]);
          setHighlightedIndex(-1);
        } else if (query.trim()) {
          // Direct URL or free-text submit
          handleAdd(query.trim());
          setQuery('');
          setIsSearching(false);
          setSearchResults([]);
        }
        break;
    }
  };

  // Reset highlight when results change
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [searchResults]);

  // Handle URL paste / direct submit
  const handleSubmit = (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    if (isUrl(query.trim())) {
      handleAdd(query.trim());
      setQuery('');
      setIsSearching(false);
      setSearchResults([]);
    }
  };

  // Reset all search state (used when adding from the results list)
  const clearSearch = () => {
    setQuery('');
    setIsSearching(false);
    setSearchResults([]);
    setHighlightedIndex(-1);
  };

  return {
    query,
    searchResults,
    searchLoading,
    highlightedIndex,
    isSearching,
    inputRef,
    handleInputChange,
    handleKeyDown,
    handleSubmit,
    handleAdd,
    clearSearch,
    setHighlightedIndex
  };
}
