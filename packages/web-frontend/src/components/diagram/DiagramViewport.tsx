/**
 * The one substrate every diagram mounts through: a React Flow instance inside its own provider,
 * carrying the shared interaction policy (`diagramInteractionProps`), a fit-to-view on first
 * layout, and one control cluster (zoom in, zoom out, fit). What differs by diagram — node and
 * edge types, colour mode, a centring callback through `onInit`, extra panels such as a
 * background or a minimap — is passed in as props and children, not duplicated here.
 */

import React, { useCallback, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  ControlButton,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  useUpdateNodeInternals,
  type Edge,
  type Node,
  type PanelPosition,
  type ReactFlowInstance,
  type ReactFlowProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Maximize } from "lucide-react";
import { diagramInteractionProps, type DiagramKind } from "./interaction";
import { REVEAL_EVENT } from "./reveal";
import { useMeasuredNodes } from "./measuredNodes";

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
  /**
   * The diagram has finished opening: its layout is final and the camera has come to rest on the
   * opening placement. Published as `data-diagram-settled`, the state a reader — or a test —
   * waits for before acting on what the diagram shows.
   */
  settled?: boolean;
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
      data-hint={label}
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

/**
 * The other half of keeping the diagram measured (see `./measuredNodes`): a node that is still
 * unmeasured once React has rendered it — a rebuild before any size was known to carry can still
 * land in the window described there — is measured again from its element. The selector folds the unmeasured
 * nodes into one string, so this runs once per change of that set and cannot loop on a node that
 * has no size to measure (a hidden one keeps the same string).
 */
function MeasureUnmeasured(): null {
  const unmeasured = useStore((state) => {
    const ids: string[] = [];
    for (const node of state.nodeLookup.values()) {
      if (!node.hidden && !node.internals.handleBounds) ids.push(node.id);
    }
    return ids.join("\u0000");
  });
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    if (unmeasured) updateNodeInternals(unmeasured.split("\u0000"));
  }, [unmeasured, updateNodeInternals]);
  return null;
}

/**
 * The diagram's side of `requestReveal` (see `./reveal`): the viewport moves its camera to the
 * node containing the element that asked. Only the mounted diagram hears the event, and only for
 * nodes it draws.
 */
function RevealListener(): null {
  const flow = useReactFlow();
  useEffect(() => {
    const onReveal = (event: Event) => {
      const node = (event.target as Element | null)?.closest<HTMLElement>(".react-flow__node");
      const id = node?.dataset.id;
      if (!id || !flow.getNode(id)) return;
      void flow.fitView({ nodes: [{ id }], padding: 0.3, maxZoom: 1, duration: 400 });
    };
    document.addEventListener(REVEAL_EVENT, onReveal);
    return () => document.removeEventListener(REVEAL_EVENT, onReveal);
  }, [flow]);
  return null;
}

export function DiagramViewport<N extends Node = Node, E extends Edge = Edge>({
  kind,
  controlsPosition = "top-right",
  onReady,
  controlButtons,
  onFit,
  showControls = true,
  settled = false,
  children,
  ...rest
}: DiagramViewportProps<N, E>): React.JSX.Element {
  const policy = useMemo(() => diagramInteractionProps(kind), [kind]);
  const { onInit, nodes: givenNodes, onNodesChange: givenOnNodesChange, ...flowProps } = rest;
  const measured = useMeasuredNodes(givenNodes, givenOnNodesChange);
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
      <RevealListener />
      <ReactFlow<N, E>
        {...policy}
        onInit={handleInit}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesReconnectable={false}
        onNodeClick={keepNodesClickable}
        proOptions={{ hideAttribution: true }}
        {...flowProps}
        nodes={measured.nodes}
        onNodesChange={measured.onNodesChange}
        data-diagram-settled={settled}
      >
        <MeasureUnmeasured />
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
