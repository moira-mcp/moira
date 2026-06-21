/**
 * Reusable component for displaying auth errors visually in forms
 * Used by all auth forms: Login, Register, ResetPassword, ForgotPassword, OAuthAuthorize
 *
 * IMPORTANT: This component reads error from context and manages its own visibility.
 * It clears the error on user input via global event listener (mounted once).
 * This prevents form re-render when error clears - only this component updates.
 */

import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAuthError } from "../../auth/AuthProvider";

export const AuthErrorDisplay: React.FC = () => {
  const { t } = useTranslation();
  const { authError, clearAuthError } = useAuthError();
  const listenerAttachedRef = useRef(false);
  const clearAuthErrorRef = useRef(clearAuthError);

  // Keep ref updated
  clearAuthErrorRef.current = clearAuthError;

  // Attach global input listener ONCE on mount (not on every render)
  // Uses ref to avoid re-running when clearAuthError reference changes
  useEffect(() => {
    if (listenerAttachedRef.current) return;
    listenerAttachedRef.current = true;

    const handleInput = () => {
      clearAuthErrorRef.current();
    };

    // Use capture phase to catch input before it bubbles
    document.addEventListener("input", handleInput, true);

    return () => {
      document.removeEventListener("input", handleInput, true);
      listenerAttachedRef.current = false;
    };
  }, []); // Empty deps - attach once

  // Reserve space for error to prevent form jumping
  // Better Auth UI card uses max-w-sm (384px), so we match that width
  // The error block should visually align with the form card above it
  return (
    <div className="min-h-[76px] w-full max-w-sm" role="alert" aria-live="assertive">
      {authError && (
        <div
          data-testid="auth-error"
          className="rounded-xl border border-destructive/30 bg-destructive/10 p-6 shadow-sm text-sm text-destructive"
        >
          <p className="font-semibold leading-none">{t("pages.authError.title")}</p>
          <p className="text-destructive mt-1.5">{authError}</p>
        </div>
      )}
    </div>
  );
};
