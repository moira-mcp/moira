/**
 * The one substrate every diagram mounts through: a React Flow instance inside its own provider,
 * carrying the shared interaction policy (`diagramInteractionProps`), a fit-to-view on first
 * layout, and one control cluster (zoom in, zoom out, fit). What differs by diagram — node and
 * edge types, colour mode, a centring callback through `onInit`, extra panels such as a
 * background or a minimap — is passed in as props and children, not duplicated here.
 */

import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  ControlButton,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type PanelPosition,
  type ReactFlowInstance,
  type ReactFlowProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Maximize } from "lucide-react";
import { diagramInteractionProps, type DiagramKind } from "./interaction";

export { diagramInteractionProps, type DiagramKind } from "./interaction";

type PolicyKey = keyof ReturnType<typeof diagramInteractionProps>;

export type DiagramViewportProps<N extends Node = Node, E extends Edge = Edge> = Omit<
  ReactFlowProps<N, E>,
  PolicyKey
> & {
  kind: DiagramKind;
  /** Where the zoom/fit cluster sits; the technical graph keeps its top-right corner. */
  controlsPosition?: PanelPosition;
  /**
   * Called once the instance exists and the opening fit has been applied, so a diagram can place
   * its own opening viewport (first block, current lane) on top of that fit.
   */
  onReady?: (instance: ReactFlowInstance<N, E>) => void;
  /** Extra buttons for the zoom/fit cluster (React Flow `ControlButton`s), so a diagram's own
   * controls sit with the standard ones instead of floating over its content. */
  controlButtons?: React.ReactNode;
  /**
   * Replaces the fit-to-view control's action. The stock control fits and centres the whole
   * diagram, which at the readable zoom floor can leave nothing but the middle of a wide process
   * on screen; a diagram that knows its own overview placement takes over from here.
   */
  onFit?: (instance: ReactFlowInstance<N, E>) => void;
  /** Mount React Flow's own zoom/fit cluster; a diagram with a toolbar of its own turns it off. */
  showControls?: boolean;
};

/** The fit-to-view button whose action the diagram owns; keeps the stock control's class. */
function FitButton<N extends Node, E extends Edge>({
  onFit,
}: {
  onFit: (instance: ReactFlowInstance<N, E>) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const instance = useReactFlow<N, E>();
  const label = t("components.workflowGraph.controls.fitViewTitle");
  return (
    <ControlButton
      className="react-flow__controls-fitview"
      onClick={() => onFit(instance)}
      title={label}
      aria-label={label}
    >
      <Maximize />
    </ControlButton>
  );
}

/**
 * React Flow routes pointer events to a node only when it is selectable, draggable, or the
 * instance has a node click handler; our nodes are none of the former (their cards carry their
 * own buttons), so a handler that does nothing keeps those buttons clickable.
 */
const keepNodesClickable = (): void => {};

export function DiagramViewport<N extends Node = Node, E extends Edge = Edge>({
  kind,
  controlsPosition = "top-right",
  onReady,
  controlButtons,
  onFit,
  showControls = true,
  children,
  ...rest
}: DiagramViewportProps<N, E>): React.JSX.Element {
  const policy = useMemo(() => diagramInteractionProps(kind), [kind]);
  const { onInit, ...flowProps } = rest;
  const handleInit = useCallback(
    (instance: ReactFlowInstance<N, E>) => {
      onInit?.(instance);
      if (!onReady) return;
      // The fit is run again here explicitly so the placement lands on a fitted viewport whether
      // or not React Flow's own fit-on-init has already happened.
      void instance.fitView(policy.fitViewOptions).then(() => onReady(instance));
    },
    [onInit, onReady, policy.fitViewOptions],
  );
  return (
    <ReactFlowProvider>
      <ReactFlow<N, E>
        {...policy}
        onInit={handleInit}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesReconnectable={false}
        onNodeClick={keepNodesClickable}
        proOptions={{ hideAttribution: true }}
        {...flowProps}
      >
        {showControls && (
          <Controls
            position={controlsPosition}
            showInteractive={false}
            showFitView={!onFit}
            fitViewOptions={policy.fitViewOptions}
          >
            {onFit && <FitButton<N, E> onFit={onFit} />}
            {controlButtons}
          </Controls>
        )}
        {children}
      </ReactFlow>
    </ReactFlowProvider>
  );
}
