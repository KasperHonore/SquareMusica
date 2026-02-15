import { useState } from 'react';

export function SearchBar({ onAdd, disabled }) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!query.trim() || loading) return;

    setLoading(true);
    try {
      await onAdd(query);
      setQuery('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search or paste YouTube URL..."
        disabled={disabled || loading}
        className="flex-1 bg-gray-700 px-4 py-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={disabled || loading || !query.trim()}
        className="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed px-6 py-3 rounded-lg font-medium transition-colors"
      >
        {loading ? '...' : 'Add'}
      </button>
    </form>
  );
}
