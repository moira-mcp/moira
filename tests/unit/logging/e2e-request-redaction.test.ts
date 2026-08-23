import { describe, expect, test } from "@jest/globals";

import { redactRequestBody } from "../../utils/redact-request-body.js";

describe("E2E failure request-body redaction", () => {
  test("masks every temporary credential while retaining safe diagnostic fields", () => {
    const temporaryPassword = "temporary-secret-sentinel";
    const confirmation = "confirmation-secret-sentinel";
    const safeMarker = "request-correlation-marker";

    const output = redactRequestBody(
      JSON.stringify({
        temporaryPassword,
        temporaryPasswordConfirm: confirmation,
        marker: safeMarker,
      }),
    );

    expect(output).toContain(safeMarker);
    expect(output).not.toContain(temporaryPassword);
    expect(output).not.toContain(confirmation);
    expect(JSON.parse(output)).toMatchObject({
      temporaryPassword: "***",
      temporaryPasswordConfirm: "***",
      marker: safeMarker,
    });
  });
});
