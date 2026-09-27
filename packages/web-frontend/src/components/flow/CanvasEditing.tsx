/**
 * The graph view as a structural canvas, in the flow page's edit mode only. The host gives the
 * graph its editing callbacks and owns what they open: a menu at the pointer for a step, a
 * connection or the empty canvas, and the same dialogs the block panel uses (rename, delete, a new
 * step placed in a block or on an edge), plus two small ones of its own — naming a new output made
 * by dragging, and leading a connection elsewhere. What each gesture means is `canvas.ts`; every
 * action commits one operation through the editing context.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { CornerDownRight, Pencil, Plus, Split, Trash2, X } from "lucide-react";
import { isValidConnectionKey } from "@mcp-moira/workflow-engine/authoring";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { GraphEditing } from "../workflow/WorkflowGraph";
import { useEditing } from "./editing";
import { connectIntent, dropOnCanvasIntent, edgeActions, insertAfterEdge } from "./canvas";
import {
  AddStepDialog,
  DeleteDialog,
  ErrorLine,
  RenameDialog,
  TargetSelect,
  useCommit,
  type StepPlacement,
} from "./StructureControls";

type Menu =
  | { kind: "node"; x: number; y: number; nodeId: string }
  | { kind: "edge"; x: number; y: number; linkId: string }
  | { kind: "pane"; x: number; y: number; blockId: string | null };

type Open =
  | { kind: "rename" | "delete"; nodeId: string }
  | { kind: "add"; placement: StepPlacement }
  | { kind: "name-output"; source: string; target: string }
  | { kind: "retarget"; linkId: string };

interface MenuItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  hint?: string;
  destructive?: boolean;
  run: () => void;
}

/**
 * A small menu at the pointer, kept inside the window; Escape, a click elsewhere or a choice
 * closes it.
 */
function PointerMenu({
  x,
  y,
  items,
  onClose,
  testId,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  testId: string;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({
      left: Math.max(0, Math.min(x, window.innerWidth - box.width)),
      top: Math.max(0, Math.min(y, window.innerHeight - box.height)),
    });
  }, [x, y]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-48 rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md"
      style={position}
      data-testid={testId}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.run();
          }}
          className={cn(
            "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:opacity-40",
            item.destructive && "text-destructive",
          )}
          data-hint={item.hint}
          data-testid={`canvas-${item.key}`}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** Naming the output a drag created: a valid, new key, then `set-connection`. */
function NameOutputDialog({
  source,
  target,
  onClose,
  onDone,
}: {
  source: string;
  target: string;
  onClose: () => void;
  /** After the connection was made (not on cancel). */
  onDone: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { draft } = useEditing();
  const { error, commit } = useCommit();
  const [key, setKey] = useState("");
  const node = draft?.nodes.find((n) => n.id === source);
  if (!node) return null;
  const problem =
    key.length > 0 && !isValidConnectionKey(key)
      ? t("pages.flowPage.structure.connections.invalidKey")
      : Object.hasOwn(node.connections ?? {}, key)
        ? t("pages.flowPage.structure.connections.keyExists")
        : null;
  const confirm = () => {
    if (!commit({ kind: "set-connection", source, key, target })) return;
    onClose();
    onDone();
  };
  return (
    <Dialog open onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-w-md" data-testid="name-output-dialog">
        <DialogHeader>
          <DialogTitle>
            {t("pages.flowPage.canvas.nameOutput.title", { source, target })}
          </DialogTitle>
          <DialogDescription>{t("pages.flowPage.canvas.nameOutput.body")}</DialogDescription>
        </DialogHeader>
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={t("pages.flowPage.structure.connections.newKey")}
          className="font-mono"
          aria-invalid={problem !== null}
          data-testid="name-output-key"
          autoFocus
          onKeyDown={(e) => e.key === "Enter" && key && !problem && confirm()}
        />
        <ErrorLine message={problem ?? error} testId="name-output-error" />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={confirm}
            disabled={!key || problem !== null}
            data-testid="name-output-confirm"
          >
            {t("pages.flowPage.structure.connections.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Leading an existing connection to another step. */
function RetargetDialog({
  linkId,
  onClose,
  onDone,
}: {
  linkId: string;
  onClose: () => void;
  /** After the connection was led elsewhere (not on cancel), with its source step. */
  onDone: (source: string) => void;
}) {
  const { t } = useTranslation();
  const { draft } = useEditing();
  const { error, commit } = useCommit();
  const edge = draft ? edgeActions(draft, linkId) : null;
  const [target, setTarget] = useState(edge?.target ?? "");
  if (!edge) return null;
  const confirm = () => {
    if (!commit({ kind: "set-connection", source: edge.source, key: edge.key, target })) return;
    onClose();
    onDone(edge.source);
  };
  return (
    <Dialog open onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-w-md" data-testid="retarget-dialog">
        <DialogHeader>
          <DialogTitle>{t("pages.flowPage.canvas.retarget.title", { edge: linkId })}</DialogTitle>
          <DialogDescription>{t("pages.flowPage.canvas.retarget.body")}</DialogDescription>
        </DialogHeader>
        <TargetSelect value={target} onChange={setTarget} testId="retarget-target" />
        <ErrorLine message={error} testId="retarget-error" />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={confirm}
            disabled={!target || target === edge.target}
            data-testid="retarget-confirm"
          >
            {t("pages.flowPage.canvas.retarget.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Hands the graph its editing callbacks while the page is in edit mode (and nothing otherwise),
 * and renders what they open.
 */
export function CanvasEditingHost({
  children,
  onFocusNode,
}: {
  children: (editing: GraphEditing | undefined) => React.ReactNode;
  /**
   * Bring a step into view after a change to it: an edit relays the graph out, and without a step
   * to follow the camera would return to the first block.
   */
  onFocusNode?: (nodeId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { enabled, draft, apply } = useEditing();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const closeMenu = React.useCallback(() => setMenu(null), []);

  // Stable while nothing it reads changes: the graph rebuilds its nodes when this does.
  const editing = useMemo<GraphEditing | undefined>(
    () =>
      enabled && draft
        ? {
            newOutputLabel: t("pages.flowPage.canvas.newOutput"),
            onConnect: (gesture) => {
              const intent = connectIntent(draft, gesture);
              if (intent.kind === "name-output") setOpen(intent);
              if (intent.kind === "op") {
                try {
                  apply(intent.op);
                  onFocusNode?.(gesture.source);
                } catch (caught) {
                  toast.error(caught instanceof Error ? caught.message : String(caught));
                }
              }
            },
            onNodeMenu: (event, nodeId, linkId) =>
              setMenu(
                linkId
                  ? { kind: "edge", x: event.clientX, y: event.clientY, linkId }
                  : { kind: "node", x: event.clientX, y: event.clientY, nodeId },
              ),
            onEdgeMenu: (event, linkId) =>
              setMenu({ kind: "edge", x: event.clientX, y: event.clientY, linkId }),
            onPaneMenu: (event, blockId) =>
              setMenu({ kind: "pane", x: event.clientX, y: event.clientY, blockId }),
            onDropOnCanvas: (gesture, blockId) => {
              const from = dropOnCanvasIntent(draft, gesture);
              if (!from) return;
              // In a flow with blocks the new step joins the block it was dropped in, or else the
              // block of the step the connection comes from.
              const owner =
                blockId ??
                draft.nodes.find((n) => n.id === from.source)?.progressNodeId ??
                undefined;
              setOpen({
                kind: "add",
                placement: { from, ...(draft.progress && owner ? { blockId: owner } : {}) },
              });
            },
          }
        : undefined,
    [enabled, draft, apply, t, onFocusNode],
  );

  const itemsOf = (current: Menu): MenuItem[] => {
    if (!draft) return [];
    if (current.kind === "node") {
      const node = draft.nodes.find((n) => n.id === current.nodeId);
      const after = insertAfterEdge(draft, current.nodeId);
      return [
        {
          key: "rename",
          label: t("pages.flowPage.structure.rename.action"),
          icon: <Pencil className="size-4" aria-hidden="true" />,
          run: () => setOpen({ kind: "rename", nodeId: current.nodeId }),
        },
        {
          key: "insert-after",
          label: t("pages.flowPage.canvas.insertAfter"),
          icon: <CornerDownRight className="size-4" aria-hidden="true" />,
          disabled: !after,
          hint: after ? undefined : t("pages.flowPage.canvas.noOutput"),
          run: () => after && setOpen({ kind: "add", placement: { edge: after } }),
        },
        {
          key: "delete",
          label: t("pages.flowPage.structure.delete.action"),
          icon: <Trash2 className="size-4" aria-hidden="true" />,
          destructive: true,
          disabled: node?.type === "start",
          run: () => setOpen({ kind: "delete", nodeId: current.nodeId }),
        },
      ];
    }
    if (current.kind === "edge") {
      const edge = edgeActions(draft, current.linkId);
      if (!edge) return [];
      return [
        {
          key: "insert-on-edge",
          label: t("pages.flowPage.canvas.insertOnEdge"),
          icon: <Split className="size-4" aria-hidden="true" />,
          run: () =>
            setOpen({ kind: "add", placement: { edge: { source: edge.source, key: edge.key } } }),
        },
        {
          key: "retarget",
          label: t("pages.flowPage.canvas.retarget.action"),
          icon: <CornerDownRight className="size-4" aria-hidden="true" />,
          run: () => setOpen({ kind: "retarget", linkId: current.linkId }),
        },
        {
          key: "remove-connection",
          label: t("pages.flowPage.structure.connections.remove", { key: edge.key }),
          icon: <X className="size-4" aria-hidden="true" />,
          destructive: true,
          disabled: edge.protected,
          hint: edge.protected ? t("pages.flowPage.structure.connections.protected") : undefined,
          run: () => {
            try {
              apply({ kind: "remove-connection", source: edge.source, key: edge.key });
              onFocusNode?.(edge.source);
            } catch (caught) {
              toast.error(caught instanceof Error ? caught.message : String(caught));
            }
          },
        },
      ];
    }
    // A flow with blocks places a new step in the block it was asked for in; without blocks, anywhere.
    const needsBlock = Boolean(draft.progress);
    return [
      {
        key: "add-step",
        label: t("pages.flowPage.canvas.addHere"),
        icon: <Plus className="size-4" aria-hidden="true" />,
        disabled: needsBlock && !current.blockId,
        hint: needsBlock && !current.blockId ? t("pages.flowPage.canvas.insideBlock") : undefined,
        run: () =>
          setOpen({
            kind: "add",
            placement: current.blockId ? { blockId: current.blockId } : {},
          }),
      },
    ];
  };

  const close = () => setOpen(null);
  return (
    <>
      {children(editing)}
      {editing && menu && (
        <PointerMenu
          x={menu.x}
          y={menu.y}
          items={itemsOf(menu)}
          onClose={closeMenu}
          testId={`canvas-menu-${menu.kind}`}
        />
      )}
      {open?.kind === "rename" && (
        <RenameDialog
          nodeId={open.nodeId}
          open
          onOpenChange={(value) => !value && close()}
          onRenamed={onFocusNode}
        />
      )}
      {open?.kind === "delete" && (
        <DeleteDialog nodeId={open.nodeId} open onOpenChange={(value) => !value && close()} />
      )}
      {open?.kind === "add" && (
        <AddStepDialog placement={open.placement} onClose={close} onAdded={onFocusNode} />
      )}
      {open?.kind === "name-output" && (
        <NameOutputDialog
          source={open.source}
          target={open.target}
          onClose={close}
          onDone={() => onFocusNode?.(open.source)}
        />
      )}
      {open?.kind === "retarget" && (
        <RetargetDialog
          linkId={open.linkId}
          onClose={close}
          onDone={(source) => onFocusNode?.(source)}
        />
      )}
    </>
  );
}
