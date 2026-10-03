/** Global authentication errors and interception, independent of form presentation. */
import React, { createContext, useContext, useSyncExternalStore } from "react";
import { Toaster } from "sonner";
import { useTranslation } from "react-i18next";
import { useAuthErrorHandler } from "../hooks/useAuthErrorHandler";

// External store for auth error - changes don't trigger parent re-renders
let authErrorStore: string | null = null;
const authErrorListeners = new Set<() => void>();

const authErrorActions = {
  set: (error: string | null) => {
    authErrorStore = error;
    authErrorListeners.forEach((listener) => listener());
  },
  clear: () => {
    authErrorStore = null;
    authErrorListeners.forEach((listener) => listener());
  },
  subscribe: (listener: () => void) => {
    authErrorListeners.add(listener);
    return () => authErrorListeners.delete(listener);
  },
  getSnapshot: () => authErrorStore,
};

// Hook to subscribe to auth error changes (only re-renders the component using it)
export const useAuthError = () => {
  const authError = useSyncExternalStore(authErrorActions.subscribe, authErrorActions.getSnapshot);

  return {
    authError,
    setAuthError: authErrorActions.set,
    clearAuthError: authErrorActions.clear,
  };
};

interface AuthErrorContextValue {
  setAuthError: (error: string | null) => void;
  clearAuthError: () => void;
}

// Context only provides setters (not the error value itself)
const AuthErrorContext = createContext<AuthErrorContextValue | undefined>(undefined);

export const useAuthErrorSetter = () => {
  const context = useContext(AuthErrorContext);
  if (!context) {
    throw new Error("useAuthErrorSetter must be used within AuthProvider");
  }
  return context;
};

const authErrorContextValue: AuthErrorContextValue = {
  setAuthError: authErrorActions.set,
  clearAuthError: authErrorActions.clear,
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { ready } = useTranslation();
  useAuthErrorHandler();

  if (!ready) {
    return <div className="flex min-h-screen items-center justify-center bg-background" />;
  }

  return (
    <AuthErrorContext.Provider value={authErrorContextValue}>
      {children}
      <Toaster richColors position="top-right" />
    </AuthErrorContext.Provider>
  );
};
