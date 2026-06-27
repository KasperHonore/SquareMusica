import { Component } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { SocketProvider } from './context/SocketContext';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Error caught by boundary:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="min-h-screen flex items-center justify-center"
          style={{ backgroundColor: 'var(--color-bg)' }}
        >
          <div className="text-center">
            <h1
              className="font-heading text-2xl mb-4"
              style={{ color: 'var(--color-text-primary)' }}
            >
              Something went wrong
            </h1>
            <p className="mb-4" style={{ color: 'var(--color-text-secondary)' }}>
              {this.state.error?.message}
            </p>
            <button onClick={() => window.location.reload()} className="btn-accent px-4 py-2">
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppContent() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        role="status"
        aria-live="polite"
        style={{ backgroundColor: 'var(--color-bg)' }}
      >
        <div className="text-xl" style={{ color: 'var(--color-text-primary)' }}>
          Loading...
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Skip link for keyboard/screen reader navigation */}
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <div id="main-content">{user ? <Dashboard /> : <Login />}</div>
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <AuthProvider>
          <SocketProvider>
            <AppContent />
          </SocketProvider>
        </AuthProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
