/**
 * "Add a choice" on an agent step in edit mode: one answer field whose options pick the route. The
 * default option continues along the step's `success` output; every other option leads to a step
 * the author picks, or to a new one created with it in a chosen block. Saving commits one
 * `set-choice` operation — one undoable edit — through the engine's `setChoice`; a step that
 * already has a choice of that shape shows it here to edit or remove. Anything richer (other
 * operators, several fields) is not offered: a step whose routing is not of this shape shows no
 * control.
 */

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { GitFork, Plus, X } from "lucide-react";
import { readChoice, type Choice } from "@mcp-moira/workflow-engine/authoring";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { guideAnchor } from "../../guides/anchors";
import type { WorkflowGraph, WorkflowNode } from "../../types/workflow-types";
import { useEditing } from "./editing";
import type { Operation } from "./operations";
import { ErrorLine, TargetSelect, useCommit } from "./StructureControls";

const NEW_STEP = "__new__";

interface OptionRow {
  name: string;
  label: string;
  /** A step id, or `NEW_STEP` for a step created with the choice. */
  target: string;
}

type EngineNode = Parameters<typeof readChoice>[0];

/** The dialog's rows: the existing choice, or two options whose first keeps the step's label. */
function initialRows(choice: Choice | null, primaryLabel: string): OptionRow[] {
  if (!choice) {
    return [
      { name: "yes", label: primaryLabel, target: "" },
      { name: "no", label: "", target: "" },
    ];
  }
  return choice.options.map((name) => ({
    name,
    label: typeof choice.labels?.[name] === "string" ? (choice.labels[name] as string) : "",
    target: choice.targets[name] ?? "",
  }));
}

/** A kebab-case id for the step an option creates, free in the draft. */
function newStepId(draft: WorkflowGraph, nodeId: string, option: string, taken: Set<string>) {
  const base =
    `${nodeId}-${option}`
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "choice-step";
  let id = base;
  for (let n = 2; draft.nodes.some((node) => node.id === id) || taken.has(id); n += 1) {
    id = `${base}-${n}`;
  }
  taken.add(id);
  return id;
}

/** The button on the step card and the dialog it opens. */
export function ChoiceEditor({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  const { t } = useTranslation();
  const { enabled, draft } = useEditing();
  const [open, setOpen] = useState(false);
  const node = draft?.nodes.find((n) => n.id === nodeId);
  if (!enabled || !draft || node?.type !== "agent-directive") return null;
  const existing = readChoice(node as unknown as EngineNode);
  // A step that routes in another way keeps that routing: the editor does not offer to replace it.
  if (!existing && ((node as { cases?: unknown[] }).cases?.length ?? 0) > 0) return null;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="mt-2 h-8 w-full gap-1.5 text-xs"
        onClick={() => setOpen(true)}
        data-testid={`choice-open-${nodeId}`}
        {...guideAnchor("flow.edit-choice")}
      >
        <GitFork className="size-3.5" aria-hidden="true" />
        {existing
          ? t("pages.flowPage.structure.choice.edit", { field: existing.field })
          : t("pages.flowPage.structure.choice.add")}
      </Button>
      {open && (
        <ChoiceDialog
          nodeId={nodeId}
          node={node}
          existing={existing}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ChoiceDialog({
  nodeId,
  node,
  existing,
  onClose,
}: {
  nodeId: string;
  node: WorkflowNode;
  existing: Choice | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { draft, blocks } = useEditing();
  const { error, commit } = useCommit();
  // A new choice keeps the label the step's main route already has, so it is not lost unseen.
  const current = node.connectionLabels?.success;
  const primaryLabel = typeof current === "string" ? current : (current?.label ?? "");
  const [field, setField] = useState(existing?.field ?? "answer");
  const [question, setQuestion] = useState(existing?.question ?? "");
  const [rows, setRows] = useState<OptionRow[]>(() => initialRows(existing, primaryLabel));
  const [defaultOption, setDefaultOption] = useState(
    existing?.defaultOption ?? initialRows(existing, primaryLabel)[0].name,
  );
  const [blockId, setBlockId] = useState(node.progressNodeId ?? blocks[0]?.id ?? "");
  if (!draft) return null;

  const update = (index: number, change: Partial<OptionRow>) => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...change } : row)));
    if (change.name !== undefined && rows[index].name === defaultOption) {
      setDefaultOption(change.name);
    }
  };
  const others = rows.filter((row) => row.name !== defaultOption);
  const creates = others.some((row) => row.target === NEW_STEP);
  const incomplete =
    !field ||
    !question.trim() ||
    rows.some((row) => !row.name) ||
    others.some((row) => !row.target) ||
    (creates && blocks.length > 0 && !blockId);

  const save = () => {
    const taken = new Set<string>();
    const newNodes: { node: WorkflowNode; blockId?: string }[] = [];
    const targets: Record<string, string> = {};
    for (const row of others) {
      if (row.target !== NEW_STEP) {
        targets[row.name] = row.target;
        continue;
      }
      const id = newStepId(draft, nodeId, row.name, taken);
      targets[row.name] = id;
      newNodes.push({
        node: {
          id,
          type: "agent-directive",
          directive: t("pages.flowPage.structure.choice.newStepDirective", {
            option: row.name,
            question: question.trim(),
          }),
          completionCondition: t("pages.flowPage.structure.choice.newStepCondition"),
        } as WorkflowNode,
        ...(blocks.length > 0 ? { blockId } : {}),
      });
    }
    const labels = Object.fromEntries(
      rows.filter((row) => row.label.trim()).map((row) => [row.name, row.label.trim()]),
    );
    const op: Operation = {
      kind: "set-choice",
      nodeId,
      choice: {
        field,
        question: question.trim(),
        options: rows.map((row) => row.name),
        defaultOption,
        targets,
        labels,
      },
      ...(newNodes.length ? { newNodes } : {}),
    };
    if (commit(op)) onClose();
  };
  const remove = () => {
    if (commit({ kind: "set-choice", nodeId, choice: null })) onClose();
  };

  return (
    <Dialog open onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-w-xl" data-testid="choice-dialog">
        <DialogHeader>
          <DialogTitle>
            {existing
              ? t("pages.flowPage.structure.choice.editTitle", { step: nodeId })
              : t("pages.flowPage.structure.choice.addTitle", { step: nodeId })}
          </DialogTitle>
          <DialogDescription>{t("pages.flowPage.structure.choice.body")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <label className="block space-y-1">
            <span className="text-xs font-medium">
              {t("pages.flowPage.structure.choice.question")}
            </span>
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={t("pages.flowPage.structure.choice.questionPlaceholder")}
              data-testid="choice-question"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium">
              {t("pages.flowPage.structure.choice.field")}
            </span>
            <Input
              value={field}
              onChange={(e) => setField(e.target.value.trim())}
              className="font-mono text-xs"
              data-testid="choice-field"
            />
          </label>
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium">
              {t("pages.flowPage.structure.choice.options")}
            </legend>
            {rows.map((row, index) => {
              const isDefault = row.name === defaultOption;
              return (
                <div
                  key={index}
                  className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center gap-1.5 rounded-md border p-1.5"
                  data-testid={`choice-option-${index}`}
                >
                  <input
                    type="radio"
                    name="choice-default"
                    checked={isDefault}
                    onChange={() => setDefaultOption(row.name)}
                    aria-label={t("pages.flowPage.structure.choice.defaultOption", {
                      option: row.name,
                    })}
                    data-testid={`choice-default-${index}`}
                  />
                  <Input
                    value={row.name}
                    onChange={(e) => update(index, { name: e.target.value.trim() })}
                    className="h-8 font-mono text-xs"
                    aria-label={t("pages.flowPage.structure.choice.optionName")}
                    data-testid={`choice-name-${index}`}
                  />
                  {isDefault ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {t("pages.flowPage.structure.choice.continues")}
                    </span>
                  ) : (
                    <TargetSelect
                      value={row.target}
                      onChange={(target) => update(index, { target })}
                      exclude={nodeId}
                      extra={[
                        { value: NEW_STEP, label: t("pages.flowPage.structure.choice.newStep") },
                      ]}
                      placeholder={t("pages.flowPage.structure.choice.target")}
                      testId={`choice-target-${index}`}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                    disabled={rows.length <= 2 || isDefault}
                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-30"
                    aria-label={t("pages.flowPage.structure.choice.removeOption", {
                      option: row.name,
                    })}
                    data-testid={`choice-remove-option-${index}`}
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </button>
                  <Input
                    value={row.label}
                    onChange={(e) => update(index, { label: e.target.value })}
                    placeholder={t("pages.flowPage.structure.choice.label")}
                    className="col-span-3 col-start-2 h-8 text-xs"
                    data-testid={`choice-label-${index}`}
                  />
                </div>
              );
            })}
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() =>
                setRows((current) => [...current, { name: "", label: "", target: "" }])
              }
              data-testid="choice-add-option"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t("pages.flowPage.structure.choice.addOption")}
            </Button>
          </fieldset>
          {creates && blocks.length > 0 && (
            <label className="block space-y-1">
              <span className="text-xs font-medium">
                {t("pages.flowPage.structure.choice.newStepBlock")}
              </span>
              <Select value={blockId} onValueChange={setBlockId}>
                <SelectTrigger className="h-8 text-xs" data-testid="choice-new-block">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {blocks.map((block) => (
                    <SelectItem key={block.id} value={block.id}>
                      {block.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}
          <ErrorLine message={error} testId="choice-error" />
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {existing ? (
            <Button
              variant="ghost"
              className="text-destructive"
              onClick={remove}
              data-testid="choice-remove"
            >
              {t("pages.flowPage.structure.choice.remove")}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button onClick={save} disabled={incomplete} data-testid="choice-save">
              {t("pages.flowPage.structure.choice.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
