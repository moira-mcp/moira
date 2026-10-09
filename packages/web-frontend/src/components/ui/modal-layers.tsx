import * as React from "react";

const ModalDepth = React.createContext(0);

/** A modal and its portaled controls own adjacent layers; nested modals start above them. */
export function ModalLayerScope({ children }: React.PropsWithChildren) {
  const depth = React.useContext(ModalDepth);
  return <ModalDepth.Provider value={depth + 1}>{children}</ModalDepth.Provider>;
}

export function useModalLayers() {
  const depth = React.useContext(ModalDepth);
  const backdrop = 50 + Math.max(0, depth - 1) * 3;
  return { backdrop, content: backdrop + 1, popup: depth === 0 ? 50 : backdrop + 2 };
}

/** Delegated document hints are rendered outside the target's React modal context. */
export function popupLayerAt(element: Element): number {
  const owner = element.closest("[data-modal-popup-layer]");
  return owner ? Number(owner.getAttribute("data-modal-popup-layer")) : 50;
}
