import { z } from "zod";

/** Correlation belongs to one fixed bootstrap invocation, never to a stable route epoch. */
export const localSetupContextSchema = z
  .object({
    spaceId: z.string().uuid(),
    generation: z.number().int().positive(),
    runtimeId: z.string().min(1).max(255),
    repositoryId: z.string().uuid(),
    operationMarker: z.string().regex(/^moira-[a-f0-9]{24}$/),
  })
  .strict();
export type LocalSetupContext = z.infer<typeof localSetupContextSchema>;
