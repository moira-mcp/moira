/**
 * AnimatedPage - Page wrapper ensuring full height for child components.
 * Required by React Flow and other components that need explicit parent height.
 */

import type { ReactNode } from "react";

interface AnimatedPageProps {
  children: ReactNode;
}

export function AnimatedPage({ children }: AnimatedPageProps) {
  return <div className="h-full">{children}</div>;
}
