import getReadingTime from "reading-time";
import { toString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";
import type { RehypePlugin, RemarkPlugin } from "@astrojs/markdown-remark";
import { getStaticArtifactsDomain } from "@mcp-moira/shared/urls";

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
export const staticDomainRemarkPlugin: RemarkPlugin = () => {
  const staticDomain = getStaticArtifactsDomain();

  return function (tree) {
    visit(tree, "code", function (node) {
      if (node.value && node.value.includes("{STATIC_DOMAIN}")) {
        node.value = node.value.replace(/\{STATIC_DOMAIN\}/g, staticDomain);
      }
    });

    visit(tree, "text", function (node) {
      if (node.value && node.value.includes("{STATIC_DOMAIN}")) {
        node.value = node.value.replace(/\{STATIC_DOMAIN\}/g, staticDomain);
      }
    });
  };
};
