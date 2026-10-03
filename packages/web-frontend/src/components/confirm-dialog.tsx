import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  children?: ReactNode;
  /** Form fields belong outside the description's paragraph. */
  content?: ReactNode | ((loading: boolean) => ReactNode);
  confirmDisabled?: boolean;
  /** A replacement decision retires an earlier asynchronous confirmation. */
  confirmationKey?: unknown;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
  onConfirm: () => void | Promise<void>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onReturnFocus?: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  content,
  confirmDisabled = false,
  confirmationKey,
  confirmLabel,
  cancelLabel,
  variant = "default",
  onConfirm,
  returnFocusRef,
  onReturnFocus,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const lifetime = useMemo(() => ({ open, confirmationKey }), [open, confirmationKey]);
  const current = useRef<typeof lifetime | null>(null);
  const submitting = useRef<typeof lifetime | null>(null);
  const [pending, setPending] = useState<typeof lifetime | null>(null);
  const loading = pending === lifetime;
  useLayoutEffect(() => {
    current.current = lifetime;
    return () => {
      current.current = null;
    };
  }, [lifetime]);
  const wasOpen = useRef(open);

  useEffect(() => {
    if (wasOpen.current && !open) {
      if (onReturnFocus) onReturnFocus();
      else if (returnFocusRef?.current?.isConnected) returnFocusRef.current.focus();
    }
    wasOpen.current = open;
  }, [open, onReturnFocus, returnFocusRef]);

  const handleConfirm = async () => {
    if (!open || confirmDisabled || current.current !== lifetime || submitting.current === lifetime)
      return;
    submitting.current = lifetime;
    setPending(lifetime);
    try {
      await onConfirm();
      if (current.current === lifetime) onOpenChange(false);
    } catch {
      // The owning action reports a localized error. Keep the dialog open so
      // the user can retry without losing context.
    } finally {
      if (submitting.current === lifetime) submitting.current = null;
      if (current.current === lifetime) setPending(null);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (submitting.current !== lifetime) onOpenChange(next);
      }}
    >
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto [overflow-wrap:anywhere]">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        {typeof content === "function" ? content(loading) : content}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>
            {cancelLabel ?? t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
            disabled={loading || confirmDisabled}
            className={cn(variant === "destructive" && buttonVariants({ variant: "destructive" }))}
          >
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {confirmLabel ?? t("common.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
