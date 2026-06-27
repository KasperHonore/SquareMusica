import { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(null);

  useEffect(() => {
    // Read errors/success signals from URL and clear them (do not accept tokens via URL).
    const params = new URLSearchParams(window.location.search);

    const errorParam = params.get('error');
    if (errorParam) {
      setAuthError(errorParam);
      window.history.replaceState({}, '', window.location.pathname);
    }
    const authParam = params.get('auth');
    if (authParam) {
      window.history.replaceState({}, '', window.location.pathname);
    }

    // Check if logged in on mount
    fetch('/api/auth/me', {
      credentials: 'include'
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.user) {
          setUser(data.user);
        } else {
          setUser(null);
        }
      })
      .catch(() => {
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = () => {
    window.location.href = '/api/auth/discord';
  };

  const logout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include'
      });
    } catch (e) {
      console.error('Logout error:', e);
    }
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, token: null, authError }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
