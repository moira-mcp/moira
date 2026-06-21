import type { ReactNode } from "react";
import { PackageOpen } from "lucide-react";
import { LazyMotion, domAnimation, m } from "motion/react";

interface EmptyStateProps {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({
  icon: Icon = PackageOpen,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <LazyMotion features={domAnimation}>
      <m.div
        className="flex flex-col items-center justify-center gap-2 py-12"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: "easeOut" }}
        data-testid="empty-state"
      >
        <Icon className="h-10 w-10 text-muted-foreground/50" />
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        {description && <p className="text-xs text-muted-foreground/70">{description}</p>}
        {action && <div className="mt-2">{action}</div>}
      </m.div>
    </LazyMotion>
  );
}
