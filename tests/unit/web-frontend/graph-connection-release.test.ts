/** @jest-environment jsdom */
/** Actual release ownership constrains retained XYFlow targets before any graph edit is admitted. */
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import {
  completeGraphConnection,
  type GraphConnectionState,
} from "../../../packages/web-frontend/src/components/workflow/graphConnection";

const elementFromPointDescriptor = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
const elementsFromPointDescriptor = Object.getOwnPropertyDescriptor(document, "elementsFromPoint");
let pane: HTMLElement;
let source: HTMLElement;
let target: HTMLElement;
let hitStack: Element[];
const gesture = { source: "start", sourceHandle: "out:new" };
const state = (valid = true): GraphConnectionState => ({
  fromNode: { id: "start" },
  fromHandle: { id: "out:new", type: "source" },
  toNode: { id: "get-task" },
  isValid: valid,
});
const mouseUp = (x = 250, y = 50) => new MouseEvent("mouseup", { clientX: x, clientY: y });

function box(element: HTMLElement, x: number, y: number, width: number, height: number): void {
  element.getBoundingClientRect = () => ({
    x,
    y,
    width,
    height,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  });
}

beforeEach(() => {
  pane = document.createElement("div");
  pane.className = "react-flow";
  document.body.append(pane);
  box(pane, 0, 0, 500, 300);
  source = document.createElement("div");
  source.setAttribute("data-graph-node", "start");
  target = document.createElement("div");
  target.setAttribute("data-graph-node", "get-task");
  pane.append(source, target);
  hitStack = [target, pane];
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: jest.fn(() => hitStack[0] ?? null),
  });
  Object.defineProperty(document, "elementsFromPoint", {
    configurable: true,
    value: jest.fn(() => hitStack),
  });
});

afterEach(() => {
  document.body.replaceChildren();
  for (const [name, descriptor] of [
    ["elementFromPoint", elementFromPointDescriptor],
    ["elementsFromPoint", elementsFromPointDescriptor],
  ] as const) {
    if (descriptor) Object.defineProperty(document, name, descriptor);
    else Reflect.deleteProperty(document, name);
  }
});

describe("connection release ownership", () => {
  test.each([true, false])(
    "a retained target cannot admit an outside release (valid=%s)",
    (valid) => {
      const panel = document.createElement("div");
      document.body.append(panel);
      hitStack = [panel, target, pane];
      expect(completeGraphConnection(pane, mouseUp(580), state(valid))).toBeNull();
    },
  );

  test("an overlay above the pane prevents a drop even inside its rectangle", () => {
    hitStack = [document.createElement("div"), target, pane];
    expect(completeGraphConnection(pane, mouseUp(), state())).toBeNull();
  });

  test.each(["retained-valid", "underlying-card", "empty-canvas"])(
    "the owned native MiniMap panel admits no %s completion",
    (path) => {
      const panel = document.createElement("div");
      panel.className = "react-flow__panel react-flow__minimap bottom right";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("react-flow__minimap-svg");
      panel.append(svg);
      pane.append(panel);
      hitStack = [svg, panel, ...(path === "underlying-card" ? [target] : []), pane];
      const retained = path === "retained-valid" ? state() : { ...state(false), toNode: null };
      expect(completeGraphConnection(pane, mouseUp(), retained)).toBeNull();
    },
  );

  test("a second graph under the pointer is not the graph completing the drag", () => {
    const foreign = document.createElement("div");
    foreign.className = "react-flow";
    const foreignCard = document.createElement("div");
    foreignCard.setAttribute("data-graph-node", "get-task");
    foreign.append(foreignCard);
    document.body.append(foreign);
    hitStack = [foreignCard, foreign, pane];
    expect(completeGraphConnection(pane, mouseUp(), state())).toBeNull();
  });

  test("a valid near-handle release on owned canvas retains its destination", () => {
    hitStack = [pane];
    expect(completeGraphConnection(pane, mouseUp(320), state())).toEqual({
      kind: "connect",
      gesture: { ...gesture, target: "get-task" },
    });
  });

  test("a card-body release uses the card under the point, not an invalid retained target", () => {
    expect(
      completeGraphConnection(pane, mouseUp(), { ...state(false), toNode: { id: "ghost" } }),
    ).toEqual({
      kind: "connect",
      gesture: { ...gesture, target: "get-task" },
    });
  });

  test.each([true, false])("dropping on the source card remains a no-op (valid=%s)", (valid) => {
    hitStack = [source, pane];
    expect(completeGraphConnection(pane, mouseUp(80), state(valid))).toBeNull();
  });

  test("a retained source-node handle cannot create a self connection", () => {
    hitStack = [pane];
    expect(
      completeGraphConnection(pane, mouseUp(), { ...state(), toNode: { id: "start" } }),
    ).toBeNull();
  });

  test.each([
    { ...state(), fromNode: { id: "foreign-source" } },
    { ...state(), toNode: { id: "foreign-target" } },
    { ...state(), fromHandle: { id: "in:new", type: "target" } },
  ])("an unavailable source/target or an input drag admits no completion: %j", (connection) => {
    expect(completeGraphConnection(pane, mouseUp(), connection)).toBeNull();
  });

  test("empty canvas retains the output and assigns only a group belonging to this graph", () => {
    const group = document.createElement("div");
    group.setAttribute("data-graph-group", "");
    group.setAttribute("data-block-id", "scope");
    pane.append(group);
    box(group, 10, 10, 350, 180);
    const foreign = document.createElement("div");
    foreign.className = "react-flow";
    const foreignGroup = document.createElement("div");
    foreignGroup.setAttribute("data-graph-group", "");
    foreignGroup.setAttribute("data-block-id", "foreign");
    foreign.append(foreignGroup);
    pane.prepend(foreign);
    box(foreignGroup, 0, 0, 500, 300);
    hitStack = [pane];
    expect(completeGraphConnection(pane, mouseUp(), { ...state(false), toNode: null })).toEqual({
      kind: "canvas",
      gesture,
      blockId: "scope",
    });
    expect(
      completeGraphConnection(pane, mouseUp(450, 250), { ...state(false), toNode: null }),
    ).toEqual({
      kind: "canvas",
      gesture,
      blockId: null,
    });
  });

  test("touch completion uses the final changed touch for inside and outside releases", () => {
    const touch = (x: number) =>
      new TouchEvent("touchend", { changedTouches: [{ clientX: x, clientY: 50 } as Touch] });
    expect(completeGraphConnection(pane, touch(250), state())).toEqual({
      kind: "connect",
      gesture: { ...gesture, target: "get-task" },
    });
    expect(completeGraphConnection(pane, touch(580), state())).toBeNull();
  });

  test.each(["touchend", "touchcancel"])(
    "an empty/cancelled %s cannot complete a retained connection",
    (type) => {
      const event = new TouchEvent(type, {
        changedTouches: type === "touchcancel" ? [{ clientX: 250, clientY: 50 } as Touch] : [],
      });
      expect(completeGraphConnection(pane, event, state())).toBeNull();
    },
  );

  test("a detached graph or a missing release hit cannot admit an edit", () => {
    hitStack = [];
    expect(completeGraphConnection(pane, mouseUp(), state())).toBeNull();
    hitStack = [target, pane];
    pane.remove();
    expect(completeGraphConnection(pane, mouseUp(), state())).toBeNull();
  });
});
