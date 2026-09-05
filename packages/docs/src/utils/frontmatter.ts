import getReadingTime from "reading-time";
import { toString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";
import type { RehypePlugin, RemarkPlugin } from "@astrojs/markdown-remark";
import { renderPortableHelpTokens } from "@mcp-moira/shared/portable-help";

export const readingTimeRemarkPlugin: RemarkPlugin = () => {
  return function (tree, file) {
    const textOnPage = toString(tree);
    const readingTime = Math.ceil(getReadingTime(textOnPage).minutes);

    if (typeof file?.data?.astro?.frontmatter !== "undefined") {
      file.data.astro.frontmatter.readingTime = readingTime;
    }
  };
};

export const responsiveTablesRehypePlugin: RehypePlugin = () => {
  return function (tree) {
    if (!tree.children) return;

    for (let i = 0; i < tree.children.length; i++) {
      const child = tree.children[i];

      if (child.type === "element" && child.tagName === "table") {
        tree.children[i] = {
          type: "element",
          tagName: "div",
          properties: {
            style: "overflow:auto",
          },
          children: [child],
        };

        i++;
      }
    }
  };
};

export const lazyImagesRehypePlugin: RehypePlugin = () => {
  return function (tree) {
    if (!tree.children) return;

    visit(tree, "element", function (node) {
      if (node.tagName === "img") {
        node.properties.loading = "lazy";
      }
    });
  };
};

/**
 * Remark plugin to replace {STATIC_DOMAIN} placeholder with actual domain
 * Works in code blocks and regular text
 */
export const portableHelpRemarkPlugin: RemarkPlugin = () => {
  return function (tree) {
    for (const nodeType of ["code", "inlineCode", "text"] as const) {
      visit(tree, nodeType, function (node) {
        if (typeof node.value === "string") node.value = renderPortableHelpTokens(node.value);
      });
    }
    visit(tree, "link", function (node) {
      if (typeof node.url === "string") node.url = renderPortableHelpTokens(node.url);
    });
  };
};

export const staticDomainRemarkPlugin = portableHelpRemarkPlugin;
