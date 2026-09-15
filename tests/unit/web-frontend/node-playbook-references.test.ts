/**
 * Which playbooks a node offers to open.
 *
 * The panel reads the node's own strings with the engine's collector rather than a second pattern
 * of its own, so what the reader is offered matches what the run will actually resolve. The case
 * that separates the two: a directive that explains the reference syntax escapes it, and must not
 * be read as naming a playbook — the same confusion that once made a bundled flow unstartable.
 */

import { collectNodeReferences } from "../../../packages/web-frontend/src/components/workflow/NodePlaybookReferences";

describe("playbook references a node offers", () => {
  test("collects a reference from any of the node's strings, without duplicates", () => {
    const references = collectNodeReferences([
      "Follow this: {{playbook:review-standard}}",
      "It follows {{playbook:review-standard}} throughout.",
      "Write in {{playbook:@jane/tone-of-voice}}",
      undefined,
    ]);

    expect(references.map((reference) => reference.text)).toEqual([
      "review-standard",
      "@jane/tone-of-voice",
    ]);
    expect(references[1].owner).toBe("@jane");
    expect(references[1].name).toBe("tone-of-voice");
  });

  test("an escaped reference is text, so no link is offered for it", () => {
    expect(collectNodeReferences(["Write it as \\{{playbook:review-standard}}"])).toEqual([]);
  });

  test("a node that names nothing offers nothing", () => {
    expect(collectNodeReferences([undefined, "", "Do the work."])).toEqual([]);
  });
});
