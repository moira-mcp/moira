/**
 * Structural editing in the block panel and the contents list, shown only in the flow page's edit
 * mode: a step's rename and delete, its connections (retarget, add, remove), a new step in a block,
 * and adding or deleting a block. Every control commits exactly one operation through the editing
 * context, so each is one undoable edit; a refusal from the engine's authoring functions is shown
 * where the author acted and nothing changes. What each action would do is read from the draft
 * first (`structure.ts`) and shown before it is confirmed.
 */

import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, MoreHorizontal, Pencil, Plus, Trash2, X } from "lucide-react";
import { AuthoringError, isValidConnectionKey } from "@mcp-moira/workflow-engine/authoring";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useNodeTypes } from "../../hooks/useNodeTypes";
import type { RunBlock } from "../run/model";
import { useEditing } from "./editing";
import type { Operation } from "./operations";
import {
  creatableTypes,
  deletePlan,
  fieldProblem,
  insertBlockChoice,
  newIdProblem,
  newNode,
  protectedKey,
  renamePreview,
  targetGroups,
  type CreatableField,
  type RenameProblem,
} from "./structure";

const DROP = "__drop__";

/** Commit one operation; a refusal from the authoring functions becomes a message, not a crash. */
export function useCommit(): {
  error: string | null;
  commit: (op: Operation) => boolean;
  clear: () => void;
} {
  const { apply } = useEditing();
  const [error, setError] = useState<string | null>(null);
  return {
    error,
    clear: () => setError(null),
    commit: (op) => {
      try {
        apply(op);
        setError(null);
        return true;
      } catch (caught) {
        if (!(caught instanceof AuthoringError)) throw caught;
        setError(caught.message);
        return false;
      }
    },
  };
}

export function ErrorLine({ message, testId }: { message: string | null; testId: string }) {
  if (!message) return null;
  return (
    <p
      className="flex items-start gap-1.5 text-xs text-destructive"
      role="alert"
      data-testid={testId}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">{message}</span>
    </p>
  );
}

/** A step picker grouped by block, with optional extra choices (dropping an edge). */
export function TargetSelect({
  value,
  onChange,
  exclude,
  extra = [],
  testId,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  exclude?: string;
  extra?: { value: string; label: string }[];
  testId: string;
  placeholder?: string;
}): React.JSX.Element {
  const { draft, blocks } = useEditing();
  const groups = useMemo(() => (draft ? targetGroups(draft, blocks) : []), [draft, blocks]);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-full min-w-0 text-xs" data-testid={testId}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {extra.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
        {groups.map((group) => (
          <SelectGroup key={group.blockId ?? ""}>
            {group.name && <SelectLabel className="text-[11px]">{group.name}</SelectLabel>}
            {group.steps
              .filter((step) => step.id !== exclude)
              .map((step) => (
                <SelectItem key={step.id} value={step.id} data-target={step.id}>
                  <span className="font-mono">{step.id}</span>
                  {step.name !== step.id && (
                    <span className="ml-1 text-muted-foreground">{step.name}</span>
                  )}
                </SelectItem>
              ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

function LocationList({
  title,
  locations,
  testId,
}: {
  title: string;
  locations: { path: string; count: number }[];
  testId: string;
}) {
  if (locations.length === 0) return null;
  return (
    <div className="space-y-1" data-testid={testId}>
      <p className="text-xs font-medium">{title}</p>
      <ul className="scrollbar-thin max-h-32 space-y-0.5 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[11px]">
        {locations.map((location) => (
          <li key={location.path} className="flex justify-between gap-2">
            <span className="min-w-0 truncate">{location.path}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">×{location.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function idProblemText(problem: RenameProblem, t: (key: string) => string): string {
  return t(`pages.flowPage.structure.idProblem.${problem}`);
}

// --- Rename

export function RenameDialog({
  nodeId,
  open,
  onOpenChange,
  onRenamed,
}: {
  nodeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After the rename is committed, with the new id. */
  onRenamed?: (id: string) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { draft } = useEditing();
  const [next, setNext] = useState(nodeId);
  const { error, commit, clear } = useCommit();
  if (!draft) return null;
  const preview = renamePreview(draft, nodeId, next);
  const confirm = () => {
    if (commit({ kind: "rename-node", from: nodeId, to: next })) {
      onOpenChange(false);
      onRenamed?.(next);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) {
          setNext(nodeId);
          clear();
        }
        onOpenChange(value);
      }}
    >
      <DialogContent className="max-w-lg" data-testid="rename-dialog">
        <DialogHeader>
          <DialogTitle>{t("pages.flowPage.structure.rename.title", { id: nodeId })}</DialogTitle>
          <DialogDescription>{t("pages.flowPage.structure.rename.body")}</DialogDescription>
        </DialogHeader>
        <label className="block space-y-1">
          <span className="text-xs font-medium">{t("pages.flowPage.structure.newId")}</span>
          <Input
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className="font-mono"
            aria-invalid={preview.problem !== null && preview.problem !== "unchanged"}
            data-testid="rename-input"
            autoFocus
          />
        </label>
        {preview.problem && preview.problem !== "unchanged" && (
          <ErrorLine message={idProblemText(preview.problem, t)} testId="rename-problem" />
        )}
        <LocationList
          title={t("pages.flowPage.structure.rename.rewritten")}
          locations={preview.references}
          testId="rename-references"
        />
        <LocationList
          title={t("pages.flowPage.structure.rename.prose")}
          locations={preview.prose}
          testId="rename-prose"
        />
        {preview.teleport && (
          <ErrorLine message={t("pages.flowPage.structure.teleport")} testId="rename-teleport" />
        )}
        <ErrorLine message={error} testId="rename-error" />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={confirm}
            disabled={preview.problem !== null}
            data-testid="rename-confirm"
          >
            {t("pages.flowPage.structure.rename.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Delete

export function DeleteDialog({
  nodeId,
  open,
  onOpenChange,
}: {
  nodeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { draft } = useEditing();
  const plan = useMemo(() => (draft ? deletePlan(draft, nodeId) : null), [draft, nodeId]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const { error, commit, clear } = useCommit();
  if (!plan) return null;
  const choiceOf = (edge: string, proposed: string | null) => choices[edge] ?? proposed ?? "";
  const undecided = plan.incoming.some((row) => !choiceOf(row.edge, row.proposed));
  const confirm = () => {
    const decisions = Object.fromEntries(
      plan.incoming.map((row) => {
        const choice = choiceOf(row.edge, row.proposed);
        return [row.edge, choice === DROP ? null : choice];
      }),
    );
    if (commit({ kind: "remove-node", nodeId, decisions })) onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) {
          setChoices({});
          clear();
        }
        onOpenChange(value);
      }}
    >
      <DialogContent className="max-w-lg" data-testid="delete-dialog">
        <DialogHeader>
          <DialogTitle>{t("pages.flowPage.structure.delete.title", { id: nodeId })}</DialogTitle>
          <DialogDescription>
            {plan.refused
              ? t("pages.flowPage.structure.delete.onlyStart")
              : plan.incoming.length > 0
                ? t(
                    plan.incoming.some((row) => row.proposed)
                      ? "pages.flowPage.structure.delete.body"
                      : "pages.flowPage.structure.delete.bodyNoDefault",
                  )
                : t("pages.flowPage.structure.delete.bodyNoIncoming")}
          </DialogDescription>
        </DialogHeader>
        {!plan.refused && plan.incoming.length > 0 && (
          <ul className="space-y-2" data-testid="delete-decisions">
            {plan.incoming.map((row) => (
              <li key={row.edge} className="space-y-1">
                <p className="font-mono text-xs">
                  {row.edge}
                  {row.protected && (
                    <span className="ml-1.5 font-sans text-[11px] text-muted-foreground">
                      {t("pages.flowPage.structure.delete.protected")}
                    </span>
                  )}
                </p>
                <TargetSelect
                  value={choiceOf(row.edge, row.proposed)}
                  onChange={(value) => setChoices((current) => ({ ...current, [row.edge]: value }))}
                  exclude={nodeId}
                  extra={
                    row.protected
                      ? []
                      : [{ value: DROP, label: t("pages.flowPage.structure.delete.drop") }]
                  }
                  placeholder={t("pages.flowPage.structure.delete.choose")}
                  testId={`delete-decision-${row.edge}`}
                />
              </li>
            ))}
          </ul>
        )}
        <LocationList
          title={t("pages.flowPage.structure.delete.dangling")}
          locations={plan.dangling}
          testId="delete-dangling"
        />
        {plan.teleport && (
          <ErrorLine message={t("pages.flowPage.structure.teleport")} testId="delete-teleport" />
        )}
        <ErrorLine message={error} testId="delete-error" />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={confirm}
            disabled={plan.refused !== null || undecided}
            data-testid="delete-confirm"
          >
            {t("pages.flowPage.structure.delete.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The step card's structural menu: rename and delete. */
export function StepActions({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  const { t } = useTranslation();
  const { enabled, draft } = useEditing();
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  if (!enabled || !draft) return null;
  const isStart = draft.nodes.find((n) => n.id === nodeId)?.type === "start";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="nodrag nopan inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("pages.flowPage.structure.stepActions")}
            data-testid={`step-actions-${nodeId}`}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => setDialog("rename")}
            data-testid={`step-rename-${nodeId}`}
          >
            <Pencil className="mr-2 size-4" aria-hidden="true" />
            {t("pages.flowPage.structure.rename.action")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setDialog("delete")}
            disabled={isStart}
            className="text-destructive focus:text-destructive"
            data-testid={`step-delete-${nodeId}`}
          >
            <Trash2 className="mr-2 size-4" aria-hidden="true" />
            {t("pages.flowPage.structure.delete.action")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === "rename" && (
        <RenameDialog nodeId={nodeId} open onOpenChange={(open) => !open && setDialog(null)} />
      )}
      {dialog === "delete" && (
        <DeleteDialog nodeId={nodeId} open onOpenChange={(open) => !open && setDialog(null)} />
      )}
    </>
  );
}

// --- Connections

/** A step's connections, each retargetable and — except its primary output — removable. */
export function ConnectionsEditor({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  const { t } = useTranslation();
  const { enabled, draft } = useEditing();
  const { error, commit } = useCommit();
  const [key, setKey] = useState("");
  const [target, setTarget] = useState("");
  const node = draft?.nodes.find((n) => n.id === nodeId);
  if (!enabled || !node || node.type === "end") return null;
  const guarded = protectedKey(node);
  const connections = Object.entries(node.connections ?? {});
  const keyProblem =
    key.length > 0 && !isValidConnectionKey(key)
      ? t("pages.flowPage.structure.connections.invalidKey")
      : Object.hasOwn(node.connections ?? {}, key)
        ? t("pages.flowPage.structure.connections.keyExists")
        : null;
  const add = () => {
    if (commit({ kind: "set-connection", source: nodeId, key, target })) {
      setKey("");
      setTarget("");
    }
  };
  return (
    <div className="mt-2 space-y-1.5" data-testid={`connections-${nodeId}`}>
      <p className="text-[11px] font-medium text-muted-foreground">
        {t("pages.flowPage.structure.connections.title")}
      </p>
      <ul className="space-y-1">
        {connections.map(([output, to]) => (
          <li
            key={output}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1.5"
            data-testid={`connection-row-${nodeId}-${output}`}
          >
            <span className="col-span-2 truncate font-mono text-[11px] text-muted-foreground">
              {output}
            </span>
            <TargetSelect
              value={to}
              onChange={(value) =>
                commit({ kind: "set-connection", source: nodeId, key: output, target: value })
              }
              testId={`connection-target-${nodeId}-${output}`}
            />
            <button
              type="button"
              onClick={() => commit({ kind: "remove-connection", source: nodeId, key: output })}
              disabled={output === guarded}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-30"
              aria-label={t("pages.flowPage.structure.connections.remove", { key: output })}
              data-hint={
                output === guarded
                  ? t("pages.flowPage.structure.connections.protected")
                  : t("pages.flowPage.structure.connections.remove", { key: output })
              }
              data-testid={`connection-remove-${nodeId}-${output}`}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5 border-t border-dashed pt-1.5">
        <Input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={t("pages.flowPage.structure.connections.newKey")}
          className="col-span-2 h-8 font-mono text-[11px]"
          aria-invalid={keyProblem !== null}
          data-testid={`connection-new-key-${nodeId}`}
        />
        <TargetSelect
          value={target}
          onChange={setTarget}
          placeholder={t("pages.flowPage.structure.connections.newTarget")}
          testId={`connection-new-target-${nodeId}`}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-8 shrink-0 px-2"
          onClick={add}
          disabled={!key || !target || keyProblem !== null}
          aria-label={t("pages.flowPage.structure.connections.add")}
          data-testid={`connection-add-${nodeId}`}
        >
          <Plus className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
      <ErrorLine message={keyProblem ?? error} testId={`connection-error-${nodeId}`} />
    </div>
  );
}

// --- New step

/** Where a new step goes: into a block (or into a workflow without blocks), or onto an edge. */
export type StepPlacement =
  | { blockId?: string }
  | { edge: { source: string; key: string } }
  /** Where an output was dropped: the new step is what it leads to; a new output is named here. */
  | { from: { source: string; key: string | null }; blockId?: string };

/** "Add step" under a block's step list: a node of a chosen type, with its required fields. */
export function AddStep({ blockId }: { blockId: string }): React.JSX.Element | null {
  const { t } = useTranslation();
  const { enabled, draft } = useEditing();
  const [open, setOpen] = useState(false);
  if (!enabled || !draft) return null;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="mt-2 h-8 w-full gap-1.5 border-dashed text-xs"
        onClick={() => setOpen(true)}
        data-testid={`block-add-step-${blockId}`}
      >
        <Plus className="size-3.5" aria-hidden="true" />
        {t("pages.flowPage.structure.addStep.action")}
      </Button>
      {open && <AddStepDialog placement={{ blockId }} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The new-step dialog: a node of any catalog type with the fields it requires, added into a block
 * or inserted on an edge (it then continues to where the edge led; see `insertNodeOnEdge`).
 */
export function AddStepDialog({
  placement,
  onClose,
  onAdded,
}: {
  placement: StepPlacement;
  onClose: () => void;
  /** After the step is committed, with its id. */
  onAdded?: (id: string) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { draft, blocks } = useEditing();
  const { catalog } = useNodeTypes();
  const types = useMemo(() => creatableTypes(catalog?.nodeTypes ?? []), [catalog]);
  const [type, setType] = useState("agent-directive");
  const [id, setId] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [outputKey, setOutputKey] = useState("");
  // Inserted between two blocks, the step joins the source's block unless the owner picks the target's.
  const [intoTarget, setIntoTarget] = useState(false);
  const { error, commit } = useCommit();
  if (!draft) return null;
  const chosen = types.find((candidate) => candidate.type === type) ?? types[0];
  const problem = newIdProblem(draft, id);
  // A structured field starts from its empty shape, so the author edits JSON rather than types it.
  const valueOf = (field: CreatableField) => values[field.name] ?? field.initial ?? "";
  const problems = Object.fromEntries(
    (chosen?.fields ?? []).map((field) => [field.name, fieldProblem(field, valueOf(field))]),
  );
  const incomplete = Object.values(problems).some((p) => p !== null);
  const onEdge = "edge" in placement ? placement.edge : null;
  const from = "from" in placement ? placement.from : null;
  const blockId = "blockId" in placement ? placement.blockId : undefined;
  const choice = onEdge ? insertBlockChoice(draft, onEdge) : null;
  const edgeSource = onEdge ? draft.nodes.find((n) => n.id === onEdge.source) : undefined;
  const edgeTarget = onEdge
    ? draft.nodes.find((n) => n.id === edgeSource?.connections?.[onEdge.key])
    : undefined;
  // A connection between two blocks that offers no choice is a return to an earlier block.
  const returning =
    !choice &&
    Boolean(edgeSource?.progressNodeId && edgeTarget?.progressNodeId) &&
    edgeSource?.progressNodeId !== edgeTarget?.progressNodeId;
  const blockName = (id: string) => blocks.find((b) => b.id === id)?.name ?? id;
  // A new output dropped on the canvas is named together with the step it will lead to.
  const naming = from !== null && from.key === null;
  const sourceNode = from ? draft.nodes.find((n) => n.id === from.source) : undefined;
  const keyProblem = !naming
    ? null
    : !outputKey
      ? "missing"
      : !isValidConnectionKey(outputKey)
        ? t("pages.flowPage.structure.connections.invalidKey")
        : Object.hasOwn(sourceNode?.connections ?? {}, outputKey)
          ? t("pages.flowPage.structure.connections.keyExists")
          : null;
  const confirm = () => {
    if (!chosen) return;
    const typed = Object.fromEntries(chosen.fields.map((field) => [field.name, valueOf(field)]));
    const node = newNode(chosen, id, typed);
    const op: Operation = onEdge
      ? {
          kind: "insert-on-edge",
          source: onEdge.source,
          key: onEdge.key,
          node,
          ...(choice && intoTarget ? { blockId: choice.target } : {}),
        }
      : from
        ? {
            kind: "add-connected-node",
            node,
            source: from.source,
            key: from.key ?? outputKey,
            ...(blockId ? { blockId } : {}),
          }
        : { kind: "add-node", node, ...(blockId ? { blockId } : {}) };
    if (commit(op)) {
      onClose();
      onAdded?.(id);
    }
  };
  return (
    <>
      <Dialog open onOpenChange={(value) => !value && onClose()}>
        <DialogContent className="max-w-lg" data-testid="add-step-dialog">
          <DialogHeader>
            <DialogTitle>
              {onEdge
                ? t("pages.flowPage.structure.addStep.insertTitle", {
                    edge: `${onEdge.source}.${onEdge.key}`,
                  })
                : from
                  ? t("pages.flowPage.structure.addStep.fromTitle", {
                      edge: `${from.source}.${from.key ?? "…"}`,
                    })
                  : t("pages.flowPage.structure.addStep.title")}
            </DialogTitle>
            <DialogDescription>
              {onEdge
                ? t("pages.flowPage.structure.addStep.insertBody")
                : from
                  ? t("pages.flowPage.structure.addStep.fromBody")
                  : t("pages.flowPage.structure.addStep.body")}
            </DialogDescription>
          </DialogHeader>
          {choice && onEdge && (
            <fieldset className="space-y-1" data-testid="add-step-block-choice">
              <legend className="text-xs font-medium">
                {t("pages.flowPage.structure.addStep.joins")}
              </legend>
              {[
                {
                  target: false,
                  block: choice.source,
                  hint: t("pages.flowPage.structure.addStep.joinsSource"),
                },
                {
                  target: true,
                  block: choice.target,
                  hint: t("pages.flowPage.structure.addStep.joinsTarget", {
                    edge: `${onEdge.source}.${onEdge.key}`,
                  }),
                },
              ].map((option) => (
                <label
                  key={option.block}
                  className="flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 text-xs has-[:checked]:border-primary"
                >
                  <input
                    type="radio"
                    name="add-step-block"
                    className="mt-0.5"
                    checked={intoTarget === option.target}
                    onChange={() => setIntoTarget(option.target)}
                    data-testid={`add-step-block-${option.block}`}
                  />
                  <span>
                    <span className="font-medium">{blockName(option.block)}</span>
                    <span className="block text-[11px] text-muted-foreground">{option.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {returning && (
            <p className="text-xs text-muted-foreground" data-testid="add-step-block-return">
              {t("pages.flowPage.structure.addStep.joinsReturn")}
            </p>
          )}
          {naming && (
            <label className="block space-y-1">
              <span className="text-xs font-medium">
                {t("pages.flowPage.structure.addStep.outputName", { source: from?.source })}
              </span>
              <Input
                value={outputKey}
                onChange={(e) => setOutputKey(e.target.value)}
                placeholder={t("pages.flowPage.structure.connections.newKey")}
                className="font-mono"
                aria-invalid={outputKey.length > 0 && keyProblem !== null}
                data-testid="add-step-output-key"
                autoFocus
              />
              {outputKey.length > 0 && keyProblem && keyProblem !== "missing" && (
                <ErrorLine message={keyProblem} testId="add-step-output-key-problem" />
              )}
            </label>
          )}
          <label className="block space-y-1">
            <span className="text-xs font-medium">
              {t("pages.flowPage.structure.addStep.type")}
            </span>
            <Select
              value={chosen?.type ?? ""}
              onValueChange={(next) => {
                setType(next);
                setValues({});
              }}
            >
              <SelectTrigger className="h-9" data-testid="add-step-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {types.map((candidate) => (
                  <SelectItem key={candidate.type} value={candidate.type}>
                    {candidate.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {chosen?.description && (
              <span className="block text-[11px] text-muted-foreground">{chosen.description}</span>
            )}
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium">{t("pages.flowPage.structure.newId")}</span>
            <Input
              value={id}
              onChange={(e) => setId(e.target.value)}
              className="font-mono"
              aria-invalid={id.length > 0 && problem !== null}
              data-testid="add-step-id"
            />
          </label>
          {id.length > 0 && problem && (
            <ErrorLine message={idProblemText(problem, t)} testId="add-step-id-problem" />
          )}
          {chosen?.fields.map((field) => (
            <label key={field.name} className="block space-y-1">
              <span className="text-xs font-medium">
                {t(`pages.flowPage.edit.fields.${field.name}`, { defaultValue: field.name })}
              </span>
              <Textarea
                value={valueOf(field)}
                onChange={(e) =>
                  setValues((current) => ({ ...current, [field.name]: e.target.value }))
                }
                className="min-h-[64px] font-mono text-xs"
                placeholder={field.description}
                aria-invalid={problems[field.name] === "json"}
                data-testid={`add-step-field-${field.name}`}
              />
              {field.kind === "json" && (
                <span className="block text-[11px] text-muted-foreground">
                  {t("pages.flowPage.structure.addStep.jsonHint")}
                </span>
              )}
              {problems[field.name] === "json" && (
                <ErrorLine
                  message={t("pages.flowPage.structure.addStep.invalidJson")}
                  testId={`add-step-field-${field.name}-problem`}
                />
              )}
            </label>
          ))}
          <ErrorLine message={error} testId="add-step-error" />
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={confirm}
              disabled={!chosen || problem !== null || incomplete || keyProblem !== null}
              data-testid="add-step-confirm"
            >
              {t("pages.flowPage.structure.addStep.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// --- Blocks

/** A contents row's delete control: enabled only for a block that owns no step. */
export function DeleteBlock({ block }: { block: RunBlock }): React.JSX.Element | null {
  const { t } = useTranslation();
  const { enabled, definition } = useEditing();
  const { error, commit } = useCommit();
  if (!enabled || !definition) return null;
  const owned = block.nodeIds.length > 0;
  return (
    <>
      <button
        type="button"
        onClick={() => commit({ kind: "remove-block", blockId: block.id })}
        disabled={owned}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-30"
        aria-label={t("pages.flowPage.structure.block.delete", { name: block.name })}
        data-hint={
          error ??
          (owned
            ? t("pages.flowPage.structure.block.notEmpty")
            : t("pages.flowPage.structure.block.delete", { name: block.name }))
        }
        data-testid={`block-delete-${block.id}`}
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
      </button>
    </>
  );
}

/** "Add block" under the contents list: an id, a name and a description, placed after a block. */
export function AddBlock({ blocks }: { blocks: readonly RunBlock[] }): React.JSX.Element | null {
  const { t } = useTranslation();
  const { enabled, definition } = useEditing();
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [summary, setSummary] = useState("");
  const [after, setAfter] = useState<string>(blocks[blocks.length - 1]?.id ?? "");
  const { error, commit, clear } = useCommit();
  if (!enabled || !definition) return null;
  const taken = blocks.some((b) => b.id === id);
  const close = () => {
    setOpen(false);
    setId("");
    setLabel("");
    setSummary("");
    clear();
  };
  const confirm = () => {
    if (
      commit({
        kind: "add-block",
        block: { id, label, summary },
        ...(after ? { after } : {}),
      })
    )
      close();
  };
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="mt-2 h-8 w-full gap-1.5 border-dashed text-xs"
        onClick={() => {
          setAfter(blocks[blocks.length - 1]?.id ?? "");
          setOpen(true);
        }}
        data-testid="block-add"
      >
        <Plus className="size-3.5" aria-hidden="true" />
        {t("pages.flowPage.structure.block.add")}
      </Button>
      <Dialog open={open} onOpenChange={(value) => (value ? setOpen(true) : close())}>
        <DialogContent className="max-w-lg" data-testid="add-block-dialog">
          <DialogHeader>
            <DialogTitle>{t("pages.flowPage.structure.block.addTitle")}</DialogTitle>
            <DialogDescription>{t("pages.flowPage.structure.block.addBody")}</DialogDescription>
          </DialogHeader>
          <label className="block space-y-1">
            <span className="text-xs font-medium">{t("pages.flowPage.structure.block.id")}</span>
            <Input
              value={id}
              onChange={(e) => setId(e.target.value.trim())}
              className="font-mono"
              aria-invalid={taken}
              data-testid="add-block-id"
            />
          </label>
          {taken && (
            <ErrorLine
              message={t("pages.flowPage.structure.block.idTaken")}
              testId="add-block-id-problem"
            />
          )}
          <label className="block space-y-1">
            <span className="text-xs font-medium">{t("pages.flowPage.structure.block.name")}</span>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              data-testid="add-block-label"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium">
              {t("pages.flowPage.structure.block.summary")}
            </span>
            <Textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              className="min-h-[64px]"
              data-testid="add-block-summary"
            />
          </label>
          {blocks.length > 0 && (
            <label className="block space-y-1">
              <span className="text-xs font-medium">
                {t("pages.flowPage.structure.block.after")}
              </span>
              <Select value={after} onValueChange={setAfter}>
                <SelectTrigger className="h-9" data-testid="add-block-after">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {blocks.map((block) => (
                    <SelectItem key={block.id} value={block.id}>
                      {block.index + 1}. {block.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}
          <ErrorLine message={error} testId="add-block-error" />
          <DialogFooter>
            <Button variant="ghost" onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={confirm}
              disabled={!id || taken || !label.trim() || !summary.trim()}
              data-testid="add-block-confirm"
            >
              {t("pages.flowPage.structure.block.addConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
