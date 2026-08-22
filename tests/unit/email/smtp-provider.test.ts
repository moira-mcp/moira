import { createServer, type Server, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import nodemailer from "nodemailer";

import { closeDatabase, getDeploymentMode, getSqliteInstance } from "@mcp-moira/shared";
import { sendEmail } from "@mcp-moira/shared/email/index.js";
import { SmtpProvider } from "../../../packages/shared/src/email/smtp-provider.js";

const original = {
  EMAIL_PROVIDER: process.env.EMAIL_PROVIDER,
  EMAIL_FROM: process.env.EMAIL_FROM,
  EMAIL_FROM_NAME: process.env.EMAIL_FROM_NAME,
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_SECURE: process.env.SMTP_SECURE,
  SMTP_REQUIRE_TLS: process.env.SMTP_REQUIRE_TLS,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASSWORD: process.env.SMTP_PASSWORD,
  DB_PATH: process.env.DB_PATH,
};

describe("SMTP provider", () => {
  let server: Server;
  let message = "";
  let rejectRecipient = false;
  let authenticatedAs: { user: string; password: string } | null = null;

  beforeAll(async () => {
    closeDatabase();
    process.env.DB_PATH = ":memory:";
    getDeploymentMode();
    server = createServer((socket: Socket) => {
      socket.setEncoding("utf8");
      socket.write("220 fixture ESMTP\r\n");
      let buffer = "";
      let readingData = false;
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        while (buffer.includes("\r\n")) {
          const boundary = buffer.indexOf("\r\n");
          const line = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (readingData) {
            if (line === ".") {
              readingData = false;
              socket.write("250 queued\r\n");
            } else {
              message += `${line}\n`;
            }
          } else if (/^(EHLO|HELO) /.test(line)) {
            socket.write("250-fixture\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n");
          } else if (/^AUTH PLAIN /i.test(line)) {
            const decoded = Buffer.from(line.slice("AUTH PLAIN ".length), "base64")
              .toString("utf8")
              .split("\u0000");
            authenticatedAs = { user: decoded.at(-2) || "", password: decoded.at(-1) || "" };
            socket.write("235 authenticated\r\n");
          } else if (/^RCPT TO:/i.test(line) && rejectRecipient) {
            socket.write("550 recipient rejected\r\n");
          } else if (/^(MAIL FROM|RCPT TO):/i.test(line)) {
            socket.write("250 OK\r\n");
          } else if (line === "DATA") {
            readingData = true;
            socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
          } else if (line === "QUIT") {
            socket.end("221 Bye\r\n");
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("SMTP fixture did not bind");
    process.env.EMAIL_PROVIDER = "smtp";
    process.env.EMAIL_FROM = "sender@example.test";
    process.env.EMAIL_FROM_NAME = "Moira Fixture";
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(address.port);
    process.env.SMTP_SECURE = "false";
    process.env.SMTP_REQUIRE_TLS = "false";
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;

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
      INSERT INTO user (id) VALUES ('smtp-service-user');
    `);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    closeDatabase();
  });

  it("selects SMTP through sendEmail, delivers content, and persists sent status", async () => {
    const result = await sendEmail("smtp-service-user", "password_reset", {
      to: "recipient@real-domain.test",
      subject: "Moira recovery fixture",
      text: "Plain recovery body",
      html: "<strong>HTML recovery body</strong>",
    });

    expect(result).toMatchObject({ success: true, provider: "smtp", delivery: "sent" });
    expect(message).toContain("To: recipient@real-domain.test");
    expect(message).toContain("Subject: Moira recovery fixture");
    expect(message).toContain("Plain recovery body");
    expect(message).toContain("<strong>HTML recovery body</strong>");
    expect(
      getSqliteInstance()
        .prepare('SELECT type, "to" AS recipient, subject, status FROM emailLog WHERE userId = ?')
        .get("smtp-service-user"),
    ).toEqual({
      type: "password_reset",
      recipient: "recipient@real-domain.test",
      subject: "Moira recovery fixture",
      status: "sent",
    });
  });

  it("authenticates with the configured SMTP user and password", async () => {
    process.env.SMTP_USER = "fixture-user";
    process.env.SMTP_PASSWORD = "fixture-password";
    try {
      const provider = new SmtpProvider();
      await provider.send({
        to: "authenticated@example.test",
        subject: "Authenticated fixture",
        text: "Authenticated delivery",
      });
      expect(authenticatedAs).toEqual({
        user: "fixture-user",
        password: "fixture-password",
      });
    } finally {
      delete process.env.SMTP_USER;
      delete process.env.SMTP_PASSWORD;
    }
  });

  it("forwards implicit TLS and required STARTTLS configuration to the transport", () => {
    process.env.SMTP_PORT = "465";
    process.env.SMTP_SECURE = "true";
    process.env.SMTP_REQUIRE_TLS = "true";
    const createTransport = jest
      .spyOn(nodemailer, "createTransport")
      .mockReturnValue({ sendMail: jest.fn() } as never);

    try {
      new SmtpProvider();
      expect(createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "127.0.0.1",
          port: 465,
          secure: true,
          requireTLS: true,
        }),
      );
    } finally {
      createTransport.mockRestore();
      process.env.SMTP_PORT = String((server.address() as { port: number }).port);
      process.env.SMTP_SECURE = "false";
      process.env.SMTP_REQUIRE_TLS = "false";
    }
  });

  it("propagates SMTP delivery failures", async () => {
    rejectRecipient = true;
    const provider = new SmtpProvider();
    await expect(
      provider.send({
        to: "rejected@example.test",
        subject: "Rejected fixture",
        text: "This must fail",
      }),
    ).rejects.toThrow(/recipient rejected|550/i);
    rejectRecipient = false;
  });
});
