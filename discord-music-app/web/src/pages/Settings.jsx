import { useTheme } from '../context/ThemeContext';

export function Settings() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div
      className="min-h-screen transition-colors duration-200"
      style={{ backgroundColor: 'var(--color-bg)', color: 'var(--color-text-primary)' }}
    >
      <div className="max-w-2xl mx-auto px-4 py-8">
        {/* Page Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold mb-2">Settings</h1>
          <p style={{ color: 'var(--color-text-secondary)' }}>Customize your experience</p>
        </div>

        {/* Settings Cards */}
        <div className="space-y-4">
          {/* Appearance Card */}
          <div
            className="backdrop-blur-sm rounded-xl p-6 shadow-soft transition-colors duration-200"
            style={{
              backgroundColor: 'var(--color-bg-raised)',
              border: '1px solid var(--color-border)'
            }}
          >
            <h2 className="text-lg font-semibold mb-4">Appearance</h2>

            {/* Theme Toggle */}
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium">Theme</h3>
                <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                  Switch between dark and light mode
                </p>
              </div>

              {/* Toggle Switch */}
              <button
                onClick={toggleTheme}
                className="relative inline-flex items-center h-10 rounded-full w-20 transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
                style={{
                  backgroundColor: theme === 'light' ? '#f59e0b' : 'var(--color-bg-elevated)',
                  '--tw-ring-offset-color': 'var(--color-bg)'
                }}
                aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              >
                <span
                  className={`inline-flex items-center justify-center w-8 h-8 transform transition-transform duration-200 bg-white rounded-full shadow-md ${
                    theme === 'light' ? 'translate-x-10' : 'translate-x-1'
                  }`}
                >
                  {theme === 'dark' ? (
                    // Moon icon
                    <svg className="w-4 h-4 text-gray-700" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                    </svg>
                  ) : (
                    // Sun icon
                    <svg className="w-4 h-4 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
                    </svg>
                  )}
                </span>
              </button>
            </div>

            {/* Current theme indicator */}
            <div
              className="mt-4 pt-4"
              style={{ borderTop: '1px solid var(--color-border)' }}
            >
              <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--color-text-muted)' }}>
                <span className={`w-2 h-2 rounded-full ${theme === 'dark' ? 'bg-indigo-400' : 'bg-amber-400'}`} />
                <span>Currently using {theme} mode</span>
              </div>
            </div>
          </div>

          {/* Placeholder for future settings */}
          <div
            className="backdrop-blur-sm rounded-xl p-6 shadow-soft transition-colors duration-200"
            style={{
              backgroundColor: 'var(--color-bg-raised)',
              border: '1px solid var(--color-border)'
            }}
          >
            <h2 className="text-lg font-semibold mb-4">Playback</h2>
            <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              Additional playback settings coming soon.
            </p>
          </div>

          <div
            className="backdrop-blur-sm rounded-xl p-6 shadow-soft transition-colors duration-200"
            style={{
              backgroundColor: 'var(--color-bg-raised)',
              border: '1px solid var(--color-border)'
            }}
          >
            <h2 className="text-lg font-semibold mb-4">Notifications</h2>
            <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              Notification preferences coming soon.
            </p>
          </div>
        </div>

        {/* App Info */}
        <div
          className="mt-8 pt-6 text-center text-sm"
          style={{
            borderTop: '1px solid var(--color-border)',
            color: 'var(--color-text-muted)'
          }}
        >
          <p>Discord Music Bot Web UI</p>
          <p className="mt-1">Version 1.0.0</p>
        </div>
      </div>
    </div>
  );
}
