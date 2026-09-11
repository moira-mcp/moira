import { z } from "zod";

export const progressContentAuthoringSchema = z
  .object({
    /** The block description: mandatory for every progress block (the process contract). */
    summary: z.string().min(1).max(1000),
    details: z.array(z.string().min(1).max(500)).max(12).optional(),
    outcome: z.string().min(1).max(1000).optional(),
    next: z.string().min(1).max(500).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Progress content must not be empty");

export const progressAuthoringSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    goal: z.string().min(1).max(1000).optional(),
    facts: z
      .array(
        z
          .object({
            label: z.string().min(1).max(100),
            value: z.string().min(1).max(500),
            tone: z.enum(["neutral", "positive", "warning", "critical"]).optional(),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    nodes: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string().min(1).max(200),
            content: progressContentAuthoringSchema,
            connections: z
              .object({ default: z.string().min(1).optional() })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      // 18 blocks: the largest bundled process (Software Development Flow) is 15 blocks; the
      // cap leaves headroom without inviting node-level diagrams.
      .max(18),
  })
  .strict();
