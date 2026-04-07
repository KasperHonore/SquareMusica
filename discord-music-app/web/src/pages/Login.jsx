import { useAuth } from '../context/AuthContext';
import { useEffect, useState } from 'react';

function MusicNoteIcon() {
  return (
    <svg
      className="w-8 h-8"
      viewBox="0 0 24 24"
      fill="currentColor"
      style={{ width: 48, height: 48 }}
    >
      <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
    </svg>
  );
}

function DiscordIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

const errorMessages = {
  not_member: 'You must be a member of the Discord server to use this app.',
  guild_fetch: 'Failed to verify server membership. Please try again.'
};

export function Login() {
  const { login, authError } = useAuth();
  const [mounted, setMounted] = useState(false);
  const [botInfo, setBotInfo] = useState(null);

  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 100);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    fetch('/api/bot-info')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setBotInfo(data);
      })
      .catch(() => {});
  }, []);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--color-bg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
        position: 'relative',
        overflow: 'hidden'
      }}
      role="main"
      aria-label="Login page"
    >
      {/* Subtle background atmosphere */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `
            radial-gradient(ellipse at 30% 40%, rgba(232,200,122,0.06) 0%, transparent 50%),
            radial-gradient(ellipse at 70% 60%, rgba(232,200,122,0.04) 0%, transparent 50%)
          `,
          pointerEvents: 'none'
        }}
      />

      {/* Noise texture */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0.03,
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
          pointerEvents: 'none'
        }}
      />

      {/* Center card */}
      <div
        style={{
          position: 'relative',
          zIndex: 10,
          maxWidth: '380px',
          width: '100%',
          transition: 'all 0.7s ease-out',
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(12px)'
        }}
      >
        <div
          style={{
            background: 'var(--color-bg-raised)',
            border: '1px solid var(--color-border-strong)',
            borderRadius: '14px',
            padding: '40px 32px',
            textAlign: 'center'
          }}
        >
          {/* Logo */}
          <div
            style={{
              marginBottom: '28px',
              transition: 'all 0.5s ease-out',
              transitionDelay: '200ms',
              opacity: mounted ? 1 : 0,
              transform: mounted ? 'translateY(0)' : 'translateY(8px)'
            }}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '12px'
              }}
            >
              {botInfo?.avatarUrl ? (
                <img
                  src={botInfo.avatarUrl}
                  alt={botInfo.name}
                  style={{
                    width: 64,
                    height: 64,
                    borderRadius: '50%',
                    objectFit: 'cover'
                  }}
                />
              ) : (
                <div style={{ color: 'var(--color-text-secondary)' }}>
                  <MusicNoteIcon />
                </div>
              )}
              <span
                style={{
                  fontFamily: 'var(--font-heading)',
                  fontSize: '36px',
                  color: 'var(--color-text-primary)',
                  letterSpacing: '-0.3px'
                }}
              >
                {botInfo?.name || 'Music'}
              </span>
            </div>
          </div>

          {/* Subtitle */}
          <p
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: '14px',
              color: 'var(--color-text-secondary)',
              marginBottom: '32px',
              transition: 'all 0.5s ease-out',
              transitionDelay: '300ms',
              opacity: mounted ? 1 : 0,
              transform: mounted ? 'translateY(0)' : 'translateY(8px)'
            }}
          >
            Sign in to continue
          </p>

          {/* Auth error message */}
          {authError && (
            <div
              style={{
                marginBottom: '20px',
                padding: '12px 16px',
                borderRadius: '8px',
                border: '1px solid rgba(232,122,122,0.3)',
                background: 'rgba(232,122,122,0.08)',
                color: 'var(--color-danger)',
                fontSize: '13px',
                textAlign: 'left'
              }}
              className="animate-fade-in"
            >
              {errorMessages[authError] || 'An error occurred. Please try again.'}
            </div>
          )}

          {/* Discord Login Button */}
          <div
            style={{
              transition: 'all 0.5s ease-out',
              transitionDelay: '400ms',
              opacity: mounted ? 1 : 0,
              transform: mounted ? 'translateY(0)' : 'translateY(8px)'
            }}
          >
            <button
              onClick={login}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                padding: '13px 20px',
                borderRadius: '8px',
                border: 'none',
                background: 'var(--color-accent)',
                color: '#0d0d0f',
                fontFamily: 'var(--font-body)',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.12s'
              }}
              className="btn-accent"
              aria-label="Continue with Discord to sign in"
              onMouseEnter={(e) => (e.currentTarget.style.filter = 'brightness(1.08)')}
              onMouseLeave={(e) => (e.currentTarget.style.filter = 'none')}
            >
              <DiscordIcon aria-hidden="true" />
              <span>Continue with Discord</span>
            </button>
          </div>

          {/* Footer text */}
          <p
            style={{
              marginTop: '24px',
              fontSize: '12px',
              color: 'var(--color-text-muted)',
              transition: 'all 0.5s ease-out',
              transitionDelay: '500ms',
              opacity: mounted ? 1 : 0,
              transform: mounted ? 'translateY(0)' : 'translateY(8px)'
            }}
          >
            Sign in to access your server's queue
          </p>
        </div>
      </div>
    </div>
  );
}
