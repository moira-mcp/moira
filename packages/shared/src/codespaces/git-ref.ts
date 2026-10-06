import { z } from "zod";

/** Existing bounded fetch-ref contract: branch, tag, symbolic ref or immutable commit. */
export const gitFetchRefSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.startsWith("-") &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      [...value].every((character) => {
        const code = character.codePointAt(0)!;
        return code > 0x20 && code !== 0x7f && !"~^:?*[\\".includes(character);
      }),
    "Invalid Git ref.",
  );

/** Git --branch semantics add component rules; Unicode is data, never an alphabet restriction. */
export const gitBranchSchema = gitFetchRefSchema.refine(
  (value) =>
    value
      .split("/")
      .every(
        (component) =>
          component.length > 0 && !component.startsWith(".") && !component.endsWith(".lock"),
      ),
  "Invalid Git branch.",
);
