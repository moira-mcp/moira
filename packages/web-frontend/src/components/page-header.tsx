import React, { type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { GuideButton } from "@/guides/GuideButton";
import { screenTourForPath } from "@/guides/registry";
import { PageHeaderContent } from "./page-header-content";

interface PageHeaderProps {
  title: string;
  description?: string;
  children?: ReactNode;
  /** The guide anchor of the page's title and description, where its screen tour starts. */
  guide?: { "data-guide": string };
}

export function PageHeader({ title, description, children, guide }: PageHeaderProps) {
  // Every screen with a tour offers it here, so a page never adds "What is this?" by hand.
  const tour = screenTourForPath(useLocation().pathname);
  return (
    <PageHeaderContent
      variant="standard"
      title={title}
      description={description}
      guide={guide}
      actions={
        children || tour ? (
          <>
            {tour && <GuideButton guideId={tour.id} />}
            {children}
          </>
        ) : undefined
      }
    />
  );
}
