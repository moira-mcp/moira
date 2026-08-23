const PASSWORD_FIELDS = [
  "password",
  "currentPassword",
  "newPassword",
  "temporaryPassword",
  "temporaryPasswordConfirm",
] as const;

export function redactRequestBody(postData: string): string {
  try {
    const parsed: unknown = JSON.parse(postData);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return JSON.stringify(parsed);
    }

    const body = parsed as Record<string, unknown>;
    for (const field of PASSWORD_FIELDS) {
      if (field in body) body[field] = "***";
    }
    return JSON.stringify(body);
  } catch {
    return postData.substring(0, 500);
  }
}
