import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { GuideButton } from "@/guides/GuideButton";
import { screenTourForPath } from "@/guides/registry";

interface PageHeaderProps {
  title: string;
  description?: string;
  children?: ReactNode;
}

export function PageHeader({ title, description, children }: PageHeaderProps) {
  // Every screen with a tour offers it here, so a page never adds "What is this?" by hand.
  const tour = screenTourForPath(useLocation().pathname);
  return (
    <div className="mb-6">
      {/* On a narrow screen the actions wrap under the title instead of squeezing it. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-72">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
        </div>
        {(children || tour) && (
          <div className="flex items-center gap-2">
            {tour && <GuideButton guideId={tour.id} />}
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
