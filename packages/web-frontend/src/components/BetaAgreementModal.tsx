/**
 * Beta Agreement Modal
 * Shown on first login - user must accept or decline beta terms
 */

import React from "react";
import { useTranslation, Trans } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { AlertTriangle } from "lucide-react";

interface BetaAgreementModalProps {
  open: boolean;
  onAccept: () => void;
  onDecline: () => void;
}

export const BetaAgreementModal: React.FC<BetaAgreementModalProps> = ({
  open,
  onAccept,
  onDecline,
}) => {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        className="max-w-2xl max-h-[90vh] overflow-y-auto"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <AlertTriangle className="w-8 h-8 text-warning" />
            <DialogTitle className="text-2xl">
              {t("components.betaAgreementModal.title")}
            </DialogTitle>
          </div>
          <DialogDescription className="text-base">
            {t("components.betaAgreementModal.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4 text-sm">
          <section>
            <h3 className="font-semibold text-base mb-2">
              {t("components.betaAgreementModal.aboutSystem")}
            </h3>
            <p className="text-muted-foreground">
              <Trans i18nKey="components.betaAgreementModal.aboutSystemText">
                MCP Moira is in <strong className="text-foreground">active development</strong>. The
                system is evolving, new features are being added.
              </Trans>
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-base mb-2">
              {t("components.betaAgreementModal.importantInfo")}
            </h3>
            <ul className="list-disc list-inside space-y-2 text-muted-foreground">
              <li>
                <Trans i18nKey="components.betaAgreementModal.dataWarning">
                  <strong className="text-foreground">Data:</strong> Data loss is possible during
                  system updates. We do our best to prevent this.
                </Trans>
              </li>
              <li>
                <Trans i18nKey="components.betaAgreementModal.functionalityWarning">
                  <strong className="text-foreground">Functionality:</strong> System behavior may
                  change. We strive to minimize inconvenience.
                </Trans>
              </li>
              <li>
                <Trans i18nKey="components.betaAgreementModal.termsWarning">
                  <strong className="text-foreground">Terms of Use:</strong> May be modified as the
                  project develops.
                </Trans>
              </li>
            </ul>
          </section>

          <section>
            <h3 className="font-semibold text-base mb-2">
              {t("components.betaAgreementModal.recommendations")}
            </h3>
            <ul className="list-disc list-inside space-y-2 text-muted-foreground">
              <li>{t("components.betaAgreementModal.backupWorkflows")}</li>
              <li>{t("components.betaAgreementModal.reportIssues")}</li>
              <li>{t("components.betaAgreementModal.helpImprove")}</li>
            </ul>
          </section>

          <section>
            <h3 className="font-semibold text-base mb-2">
              {t("components.betaAgreementModal.acceptance")}
            </h3>
            <ul className="list-disc list-inside space-y-2 text-muted-foreground">
              <li>{t("components.betaAgreementModal.understandDevelopment")}</li>
              <li>{t("components.betaAgreementModal.readyForChanges")}</li>
              <li>{t("components.betaAgreementModal.agreeToTerms")}</li>
            </ul>
          </section>

          <div className="mt-4 pt-4 border-t border-border">
            <p className="text-muted-foreground text-center">
              {t("components.betaAgreementModal.thankYou")}
            </p>
          </div>
        </div>

        <DialogFooter className="gap-3 sm:gap-2">
          <Button variant="outline" onClick={onDecline} className="sm:flex-1">
            {t("components.betaAgreementModal.decline")}
          </Button>
          <Button
            onClick={onAccept}
            className="sm:flex-1 bg-warning text-warning-foreground hover:bg-warning/90"
          >
            {t("components.betaAgreementModal.acceptAndContinue")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
