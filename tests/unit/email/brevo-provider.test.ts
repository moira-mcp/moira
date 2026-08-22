import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import * as brevo from "@getbrevo/brevo";

import { closeDatabase, getDeploymentMode, getSqliteInstance } from "@mcp-moira/shared";
import { sendEmail } from "@mcp-moira/shared/email/index.js";

const original = {
  EMAIL_PROVIDER: process.env.EMAIL_PROVIDER,
  EMAIL_FROM: process.env.EMAIL_FROM,
  EMAIL_FROM_NAME: process.env.EMAIL_FROM_NAME,
  EMAIL_TEST_RECIPIENTS: process.env.EMAIL_TEST_RECIPIENTS,
  BREVO_API_KEY: process.env.BREVO_API_KEY,
  DB_PATH: process.env.DB_PATH,
};

describe("Brevo provider", () => {
  const sendTransacEmail = jest
    .spyOn(brevo.TransactionalEmailsApi.prototype, "sendTransacEmail")
    .mockResolvedValue({ body: { messageId: "brevo-fixture-message" } } as never);

  beforeAll(() => {
    closeDatabase();
    process.env.DB_PATH = ":memory:";
    process.env.EMAIL_PROVIDER = "brevo";
    process.env.EMAIL_FROM = "sender@example.test";
    process.env.EMAIL_FROM_NAME = "Moira Fixture";
    process.env.BREVO_API_KEY = "local-transport-stub";
    delete process.env.EMAIL_TEST_RECIPIENTS;
    getDeploymentMode();

    getSqliteInstance().exec(`
      CREATE TABLE user (
        id TEXT PRIMARY KEY NOT NULL
      );
      CREATE TABLE emailLog (
        id TEXT PRIMARY KEY NOT NULL,
        userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        "to" TEXT NOT NULL,
        subject TEXT NOT NULL,
        messageId TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        createdAt TEXT NOT NULL
      );
      INSERT INTO user (id) VALUES ('brevo-service-user');
    `);
  });

  afterAll(() => {
    sendTransacEmail.mockRestore();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    closeDatabase();
  });

  it("returns and persists provider-neutral sent delivery without network access", async () => {
    const result = await sendEmail("brevo-service-user", "verification", {
      to: "recipient@real-domain.example",
      subject: "Moira verification fixture",
      text: "Plain verification body",
      html: "<strong>HTML verification body</strong>",
    });

    expect(result).toEqual({
      messageId: "brevo-fixture-message",
      success: true,
      provider: "brevo",
      delivery: "sent",
    });
    expect(sendTransacEmail).toHaveBeenCalledTimes(1);
    expect(sendTransacEmail.mock.calls[0]?.[0]).toMatchObject({
      sender: { email: "sender@example.test", name: "Moira Fixture" },
      to: [{ email: "recipient@real-domain.example" }],
      subject: "Moira verification fixture",
      textContent: "Plain verification body",
      htmlContent: "<strong>HTML verification body</strong>",
    });
    expect(
      getSqliteInstance()
        .prepare(
          'SELECT type, "to" AS recipient, subject, messageId, status FROM emailLog WHERE userId = ?',
        )
        .get("brevo-service-user"),
    ).toEqual({
      type: "verification",
      recipient: "recipient@real-domain.example",
      subject: "Moira verification fixture",
      messageId: "brevo-fixture-message",
      status: "sent",
    });
  });
});
