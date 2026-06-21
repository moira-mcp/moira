import type { ReactNode } from "react";
import { cn } from "../lib/utils";

interface FadeInProps {
  children: ReactNode;
  className?: string;
}

/** Content entrance animation. Wrap page content that appears after loading. */
export function FadeIn({ children, className }: FadeInProps) {
  return (
    <div
      className={cn(
        "animate-in fade-in slide-in-from-bottom-3 duration-300 fill-mode-both",
        className,
      )}
    >
      {children}
    </div>
  );
}
