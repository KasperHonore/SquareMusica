export function Settings() {
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
