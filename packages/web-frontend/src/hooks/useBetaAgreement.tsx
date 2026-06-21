/**
 * Beta Agreement Hook
 * Manages beta agreement state using localStorage OR cookie.
 * Cookie support allows E2E tests to bypass modal without page navigation.
 */

import { useState, useEffect } from "react";
import { useFeatures } from "./useFeatures";

const BETA_AGREEMENT_KEY = "moira-beta-agreement-accepted";
const BETA_AGREEMENT_COOKIE = "moira-beta-accepted";

/**
 * Check if beta agreement cookie is set.
 * Cookie name: moira-beta-accepted=true
 */
function hasBetaCookie(): boolean {
  return document.cookie
    .split(";")
    .some((c) => c.trim().startsWith(`${BETA_AGREEMENT_COOKIE}=true`));
}

interface BetaAgreementState {
  // Modal state
  showModal: boolean;
  hasAccepted: boolean;
  acceptAgreement: () => void;
  declineAgreement: () => void;

  // Banner state
  showBanner: boolean;
  dismissBanner: () => void;
}

export const useBetaAgreement = (isAuthenticated: boolean): BetaAgreementState => {
  const { isEnabled } = useFeatures();
  const betaNotices = isEnabled("betaNotices");
  const [hasAccepted, setHasAccepted] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  // Check localStorage AND cookie on mount
  useEffect(() => {
    // Beta notices are SaaS-only; in self-host the modal/banner never show.
    if (!betaNotices || !isAuthenticated) {
      setShowModal(false);
      return;
    }

    // Check both localStorage and cookie
    const acceptedInStorage = localStorage.getItem(BETA_AGREEMENT_KEY) === "true";
    const acceptedViaCookie = hasBetaCookie();
    const accepted = acceptedInStorage || acceptedViaCookie;

    setHasAccepted(accepted);

    // Show modal if not accepted and user is authenticated
    if (!accepted) {
      setShowModal(true);
    }
  }, [isAuthenticated, betaNotices]);

  const acceptAgreement = () => {
    localStorage.setItem(BETA_AGREEMENT_KEY, "true");
    setHasAccepted(true);
    setShowModal(false);
  };

  const declineAgreement = () => {
    // Declining will cause logout in MainAppLayout
    setShowModal(false);
  };

  const dismissBanner = () => {
    setBannerDismissed(true);
  };

  return {
    showModal,
    hasAccepted,
    acceptAgreement,
    declineAgreement,
    showBanner: betaNotices && hasAccepted && !bannerDismissed,
    dismissBanner,
  };
};
