/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { ConfirmDialog } from "../../../packages/web-frontend/src/components/confirm-dialog";

const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;
beforeEach(() => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
});
afterEach(() => {
  cleanup();
  const target = globalThis as typeof globalThis & { React?: typeof React };
  if (originalReact) target.React = originalReact;
  else delete target.React;
});

function pending() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("shared confirmation decisions", () => {
  test("fences two synchronous activations and closes only after the operation succeeds", async () => {
    const operation = pending();
    const persisted: string[] = [];
    const closed: boolean[] = [];
    render(
      <ConfirmDialog
        open
        title="Stop task"
        description="One task"
        onOpenChange={(open) => closed.push(open)}
        onConfirm={async () => {
          persisted.push("stopped");
          await operation.promise;
        }}
      />,
    );
    const confirm = screen.getByRole("button", { name: "Confirm" });
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(persisted).toEqual(["stopped"]);
    expect(closed).toEqual([]);
    await act(async () => operation.resolve());
    expect(closed).toEqual([false]);
  });

  test("a refused operation retains the form and supports an explicit retry", async () => {
    const operation = pending();
    const closed = jest.fn();
    const confirm = jest
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(operation.promise)
      .mockResolvedValueOnce();
    render(
      <ConfirmDialog
        open
        title="Stop task"
        description="One task"
        content={
          <label>
            Reason
            <textarea defaultValue="Preserve this reason" />
          </label>
        }
        onOpenChange={closed}
        onConfirm={confirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await act(async () => operation.reject(new Error("stale revision")));
    expect(screen.getByRole("textbox", { name: "Reason" })).toHaveValue("Preserve this reason");
    expect(closed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(closed).toHaveBeenCalledWith(false));
  });

  test("a late A confirmation cannot close or clear a replacement B or new A decision", async () => {
    const operation = pending();
    const closed = jest.fn();
    const firstA = {};
    const props = {
      open: true,
      title: "Stop task",
      description: "One task",
      onOpenChange: closed,
      onConfirm: () => operation.promise,
    };
    const view = render(<ConfirmDialog {...props} confirmationKey={firstA} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    view.rerender(
      <ConfirmDialog
        {...props}
        confirmationKey={{}}
        content={<textarea aria-label="Reason" defaultValue="B reason" />}
      />,
    );
    view.rerender(
      <ConfirmDialog
        {...props}
        confirmationKey={{}}
        content={<textarea key="new-a" aria-label="Reason" defaultValue="New A reason" />}
      />,
    );
    await act(async () => operation.resolve());
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Reason" })).toHaveValue("New A reason");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeEnabled();
  });

  test("validation disables confirmation and fields are outside the description paragraph", () => {
    const confirm = jest.fn<() => void>();
    render(
      <ConfirmDialog
        open
        title="Stop task"
        description="Required reason"
        content={
          <label>
            Reason
            <textarea />
          </label>
        }
        confirmDisabled
        onOpenChange={() => undefined}
        onConfirm={confirm}
      />,
    );
    const reason = screen.getByRole("textbox", { name: "Reason" });
    expect(reason.closest("p")).toBeNull();
    expect(screen.getByRole("alertdialog")).toContainElement(reason);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});
