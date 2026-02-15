import { useAuth } from '../context/AuthContext';
import { useEffect, useState } from 'react';

// Animated music note that floats across the screen
function FloatingNote({ delay, duration, startX, startY, size, rotation }) {
  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left: `${startX}%`,
        top: `${startY}%`,
        animationDelay: `${delay}s`,
        animationDuration: `${duration}s`,
      }}
    >
      <svg
        className="text-accent/20 animate-float"
        style={{
          width: size,
          height: size,
          transform: `rotate(${rotation}deg)`,
          animationDelay: `${delay}s`,
          animationDuration: `${duration}s`,
        }}
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
      </svg>
    </div>
  );
}

// Floating vinyl disc decoration
function FloatingVinyl({ delay, x, y, size }) {
  return (
    <div
      className="absolute pointer-events-none animate-spin-slow"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        width: size,
        height: size,
        animationDelay: `${delay}s`,
        animationDuration: '20s',
      }}
    >
      <div
        className="w-full h-full rounded-full border-4 border-accent/10 relative"
        style={{
          background: 'radial-gradient(circle at center, transparent 30%, rgba(29, 185, 84, 0.05) 31%, rgba(29, 185, 84, 0.1) 50%, rgba(29, 185, 84, 0.05) 70%, transparent 71%)',
        }}
      >
        {/* Center hole */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-surface" />
        {/* Grooves */}
        <div className="absolute inset-4 rounded-full border border-white/5" />
        <div className="absolute inset-8 rounded-full border border-white/5" />
      </div>
    </div>
  );
}

// Glowing orb decoration
function GlowOrb({ x, y, size, color, delay }) {
  return (
    <div
      className="absolute rounded-full animate-pulse-glow pointer-events-none blur-3xl"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        width: size,
        height: size,
        background: color,
        animationDelay: `${delay}s`,
        opacity: 0.4,
      }}
    />
  );
}

function MusicIcon() {
  return (
    <svg
      className="w-12 h-12 text-accent"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6zm-2 16c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z" />
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

// Sound wave bars animation
function SoundWave() {
  return (
    <div className="flex items-end gap-1 h-8">
      {[0.6, 1, 0.4, 0.8, 0.5].map((height, i) => (
        <div
          key={i}
          className="w-1 bg-accent/30 rounded-full animate-wave"
          style={{
            height: `${height * 100}%`,
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </div>
  );
}

export function Login() {
  const { login } = useAuth();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Trigger entrance animations after mount
    const timer = setTimeout(() => setMounted(true), 100);
    return () => clearTimeout(timer);
  }, []);

  // Floating decorations configuration
  const floatingNotes = [
    { delay: 0, duration: 15, startX: 10, startY: 20, size: 40, rotation: -15 },
    { delay: 2, duration: 18, startX: 85, startY: 30, size: 30, rotation: 20 },
    { delay: 4, duration: 20, startX: 75, startY: 70, size: 50, rotation: -10 },
    { delay: 1, duration: 16, startX: 15, startY: 75, size: 35, rotation: 25 },
    { delay: 3, duration: 22, startX: 90, startY: 85, size: 25, rotation: -20 },
  ];

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-4 relative overflow-hidden" role="main" aria-label="Login page">
      {/* ====== ANIMATED MESH GRADIENT BACKGROUND ====== */}
      <div className="absolute inset-0">
        {/* Base gradient layer */}
        <div
          className="absolute inset-0 animate-gradient"
          style={{
            background: `
              radial-gradient(ellipse at 20% 20%, rgba(29, 185, 84, 0.15) 0%, transparent 50%),
              radial-gradient(ellipse at 80% 80%, rgba(29, 185, 84, 0.1) 0%, transparent 50%),
              radial-gradient(ellipse at 50% 50%, rgba(29, 185, 84, 0.05) 0%, transparent 70%),
              linear-gradient(135deg, #121212 0%, #181818 50%, #121212 100%)
            `,
            backgroundSize: '200% 200%',
          }}
        />

        {/* Animated gradient orbs */}
        <GlowOrb x={15} y={20} size="300px" color="rgba(29, 185, 84, 0.3)" delay={0} />
        <GlowOrb x={70} y={60} size="400px" color="rgba(29, 185, 84, 0.2)" delay={1} />
        <GlowOrb x={80} y={10} size="200px" color="rgba(29, 185, 84, 0.25)" delay={2} />
        <GlowOrb x={10} y={70} size="250px" color="rgba(29, 185, 84, 0.15)" delay={1.5} />

        {/* Noise texture overlay for depth */}
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
          }}
        />
      </div>

      {/* ====== FLOATING DECORATIVE ELEMENTS ====== */}
      {floatingNotes.map((note, i) => (
        <FloatingNote key={i} {...note} />
      ))}
      <FloatingVinyl delay={0} x={5} y={10} size="120px" />
      <FloatingVinyl delay={2} x={85} y={65} size="80px" />

      {/* ====== MAIN CONTENT CARD ====== */}
      <div
        className={`
          relative z-10 max-w-md w-full
          transition-all duration-700 ease-out
          ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}
        `}
      >
        {/* Glass card with premium styling */}
        <div className="card-glass p-10 text-center relative overflow-hidden">
          {/* Subtle gradient border glow */}
          <div
            className="absolute inset-0 rounded-xl opacity-50"
            style={{
              background: 'linear-gradient(135deg, rgba(29, 185, 84, 0.1) 0%, transparent 50%, rgba(29, 185, 84, 0.05) 100%)',
              padding: '1px',
            }}
          />

          {/* Logo with staggered animation */}
          <div
            className={`
              mb-8 flex justify-center
              transition-all duration-500 ease-out
              ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}
            `}
            style={{ transitionDelay: '200ms' }}
          >
            <div className="relative">
              {/* Glow behind icon */}
              <div className="absolute inset-0 bg-accent/20 rounded-full blur-xl scale-150" />
              <div className="relative p-5 rounded-full bg-surface-elevated border border-accent/20 glow-accent">
                <MusicIcon />
              </div>
            </div>
          </div>

          {/* Sound wave decoration */}
          <div
            className={`
              flex justify-center mb-6
              transition-all duration-500 ease-out
              ${mounted ? 'opacity-100' : 'opacity-0'}
            `}
            style={{ transitionDelay: '300ms' }}
          >
            <SoundWave />
          </div>

          {/* Title with staggered animation */}
          <h1
            className={`
              text-4xl font-heading font-extrabold text-primary mb-3 tracking-tight
              transition-all duration-500 ease-out
              ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}
            `}
            style={{ transitionDelay: '400ms' }}
          >
            Music Bot
          </h1>

          {/* Subtitle with staggered animation */}
          <p
            className={`
              text-secondary text-lg mb-10
              transition-all duration-500 ease-out
              ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}
            `}
            style={{ transitionDelay: '500ms' }}
          >
            Control your server's music from anywhere
          </p>

          {/* Discord Login Button with glow effect */}
          <div
            className={`
              transition-all duration-500 ease-out
              ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}
            `}
            style={{ transitionDelay: '600ms' }}
          >
            <button
              onClick={login}
              className="
                w-full btn-accent px-6 py-4 text-lg
                flex items-center justify-center gap-3
                hover:glow-accent-lg
                group relative overflow-hidden
                min-h-[56px] focus-ring
              "
              aria-label="Continue with Discord to sign in"
            >
              {/* Animated shine effect on hover */}
              <div
                className="
                  absolute inset-0 -translate-x-full
                  bg-gradient-to-r from-transparent via-white/20 to-transparent
                  group-hover:translate-x-full transition-transform duration-700
                "
                aria-hidden="true"
              />
              <DiscordIcon aria-hidden="true" />
              <span className="relative font-heading font-semibold">Continue with Discord</span>
            </button>
          </div>

          {/* Footer text with staggered animation */}
          <p
            className={`
              mt-8 text-muted text-sm
              transition-all duration-500 ease-out
              ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}
            `}
            style={{ transitionDelay: '700ms' }}
          >
            Sign in to access your server's queue
          </p>
        </div>

        {/* Bottom decorative element */}
        <div
          className={`
            flex justify-center mt-6 gap-2
            transition-all duration-500 ease-out
            ${mounted ? 'opacity-100' : 'opacity-0'}
          `}
          style={{ transitionDelay: '800ms' }}
        >
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-accent/40"
              style={{ animationDelay: `${i * 0.2}s` }}
            />
          ))}
        </div>
      </div>

      {/* ====== CUSTOM STYLES FOR ANIMATIONS ====== */}
      <style>{`
        @keyframes float {
          0%, 100% {
            transform: translateY(0) rotate(var(--rotation, 0deg));
            opacity: 0.2;
          }
          50% {
            transform: translateY(-20px) rotate(calc(var(--rotation, 0deg) + 5deg));
            opacity: 0.4;
          }
        }

        .animate-float {
          animation: float 6s ease-in-out infinite;
        }

        @keyframes spin-slow {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }

        .animate-spin-slow {
          animation: spin-slow 20s linear infinite;
        }
      `}</style>
    </div>
  );
}
