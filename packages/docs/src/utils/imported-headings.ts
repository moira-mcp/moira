import type { Expression, ImportDeclaration, Node, Program } from "estree";

function visit(node: Node, inspect: (node: Node) => void): void {
  inspect(node);
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === "object" && typeof child.type === "string") {
        visit(child as Node, inspect);
      }
    }
  }
}

/** Compose Astro's native heading metadata for pages made from Markdown fragments. */
export function importedHeadingsRecmaPlugin() {
  return (tree: Program): void => {
    const headingExport = tree.body.find(
      (node) =>
        node.type === "ExportNamedDeclaration" &&
        node.declaration?.type === "FunctionDeclaration" &&
        node.declaration.id?.name === "getHeadings",
    );
    if (
      headingExport?.type !== "ExportNamedDeclaration" ||
      headingExport.declaration?.type !== "FunctionDeclaration"
    ) {
      return;
    }
    const result = headingExport.declaration.body.body.find(
      (node) => node.type === "ReturnStatement",
    );
    // Authored MDX retains its own native metadata. This hook composes fragment-only pages.
    if (result?.argument?.type !== "ArrayExpression" || result.argument.elements.length > 0) {
      return;
    }

    const fragments = new Map<string, ImportDeclaration>();
    for (const node of tree.body) {
      if (node.type !== "ImportDeclaration" || !String(node.source.value).endsWith(".md")) {
        continue;
      }
      for (const specifier of node.specifiers) {
        if (
          specifier.type === "ImportSpecifier" &&
          specifier.imported.type === "Identifier" &&
          specifier.imported.name === "Content"
        ) {
          fragments.set(specifier.local.name, node);
        }
      }
    }
    if (fragments.size === 0) return;

    const identifiers = new Set<string>();
    const rendered: string[] = [];
    visit(tree, (node) => {
      if (node.type === "Identifier") identifiers.add(node.name);
      if (node.type !== "CallExpression") return;
      const component = node.arguments[0];
      if (component?.type === "Identifier" && fragments.has(component.name)) {
        rendered.push(component.name);
      }
    });
    if (rendered.length === 0) return;

    const helpers = new Map<ImportDeclaration, string>();
    result.argument.elements = rendered.map((name) => {
      const declaration = fragments.get(name)!;
      let helper = helpers.get(declaration);
      if (!helper) {
        let suffix = helpers.size;
        do {
          helper = `__importedHeadings${suffix++}`;
        } while (identifiers.has(helper));
        identifiers.add(helper);
        helpers.set(declaration, helper);
        declaration.specifiers.push({
          type: "ImportSpecifier",
          imported: { type: "Identifier", name: "getHeadings" },
          local: { type: "Identifier", name: helper },
        });
      }
      return {
        type: "SpreadElement",
        argument: {
          type: "CallExpression",
          callee: { type: "Identifier", name: helper },
          arguments: [],
          optional: false,
        } satisfies Expression,
      };
    });
  };
}
