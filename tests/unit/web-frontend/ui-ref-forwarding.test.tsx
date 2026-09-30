/** @jest-environment jsdom */
/**
 * Radix triggers written with `asChild` (popovers, tooltips, menus) position their content from the
 * ref they pass to their child. On React 18 a function component drops that ref unless it forwards
 * it, and the content then never leaves its off-screen starting place — so the shared controls that
 * stand under such triggers must hand the ref to their DOM element.
 */

import { describe, expect, test } from "@jest/globals";
import { render } from "@testing-library/react";
import React, { createRef } from "react";
import { Badge } from "../../../packages/web-frontend/src/components/ui/badge";
import { Button } from "../../../packages/web-frontend/src/components/ui/button";

describe("shared controls forward their ref", () => {
  test("a button hands its ref to the button element", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Filters</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current?.textContent).toBe("Filters");
  });

  test("a button rendered as its child hands its ref to that child", () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <Button ref={ref} asChild>
        <a href="/overview">Overview</a>
      </Button>,
    );
    expect(ref.current).toBeInstanceOf(HTMLAnchorElement);
  });

  test("a badge hands its ref to its element", () => {
    const ref = createRef<HTMLDivElement>();
    render(<Badge ref={ref}>Level 2</Badge>);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
    expect(ref.current?.textContent).toBe("Level 2");
  });
});
