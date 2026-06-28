/**
 * SearchBar - search input form with icon and inline loading spinner.
 */
export function SearchBar({
  inputRef,
  query,
  onInputChange,
  onKeyDown,
  onSubmit,
  placeholder,
  searchLoading,
  isSearching
}) {
  return (
    <form onSubmit={onSubmit} style={{ position: 'relative' }}>
      {/* Search icon */}
      <svg
        style={{
          position: 'absolute',
          left: '15px',
          top: '50%',
          transform: 'translateY(-50%)',
          color: 'var(--color-text-muted)',
          pointerEvents: 'none'
        }}
        width="16"
        height="16"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth="2"
      >
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.35-4.35" />
      </svg>

      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={onInputChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck="false"
        aria-label="Search for music"
        style={{
          width: '100%',
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border)',
          borderRadius: '10px',
          padding: '13px 44px',
          fontFamily: "'DM Sans', sans-serif",
          fontSize: '14px',
          color: 'var(--color-text-primary)',
          outline: 'none',
          transition: 'border-color 0.2s'
        }}
        onFocus={(e) => {
          e.target.style.borderColor = 'rgba(232,200,122,0.35)';
        }}
        onBlur={(e) => {
          e.target.style.borderColor = 'var(--color-border)';
        }}
      />

      {/* Search spinner */}
      {searchLoading && isSearching && (
        <div
          style={{
            position: 'absolute',
            right: '15px',
            top: '50%',
            transform: 'translateY(-50%)',
            width: '14px',
            height: '14px',
            border: '2px solid var(--color-border)',
            borderTopColor: 'var(--color-accent)',
            borderRadius: '50%',
            animation: 'wave-spin 0.7s linear infinite'
          }}
        />
      )}
      <style>{`
        @keyframes wave-spin { to { transform: translateY(-50%) rotate(360deg); } }
        input::placeholder { color: var(--color-text-muted); }
      `}</style>
    </form>
  );
}
