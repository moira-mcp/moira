import { hkdfSync } from "node:crypto";
import {
  CodespaceFileCapabilities,
  CodespaceFileTransferService,
  CodespaceResourceError,
  getAccountAccessDenial,
  getBaseUrl,
  getBetterAuthSecret,
  getSqliteInstance,
} from "@mcp-moira/shared";
import {
  buildFileClientLifeProbe,
  buildFileClientMaintenance,
  loadFileClientAssets,
} from "./codespace-file-client-assets.js";

type Dependencies = ConstructorParameters<typeof CodespaceFileTransferService>[0];

/** Use one purpose-specific signing key for both issuance and HTTP verification. */
export function createCodespaceFileCapabilities(now?: () => number): CodespaceFileCapabilities {
  return new CodespaceFileCapabilities(
    Buffer.from(
      hkdfSync("sha256", getBetterAuthSecret(), "", "moira/codespace-files/v1/signing-key", 32),
    ).toString("hex"),
    now,
  );
}

/** The production adapters and integration fixtures share this orchestration boundary. */
export function createCodespaceFileTransfers(
  dependencies: Omit<
    Dependencies,
    "origin" | "capabilities" | "requireAccount" | "assets" | "lifeProbe" | "installer"
  > &
    Partial<
      Pick<
        Dependencies,
        "origin" | "capabilities" | "requireAccount" | "assets" | "lifeProbe" | "installer"
      >
    >,
): CodespaceFileTransferService {
  return new CodespaceFileTransferService({
    origin: dependencies.origin ?? getBaseUrl(),
    capabilities: dependencies.capabilities ?? createCodespaceFileCapabilities(dependencies.now),
    requireAccount(userId) {
      const account = getSqliteInstance()
        .prepare("SELECT blocked, approvedAt, emailVerified FROM user WHERE id = ?")
        .get(userId) as
        { blocked: number; approvedAt: string | null; emailVerified: number } | undefined;
      if (
        !account ||
        getAccountAccessDenial(
          {
            userId,
            blocked: !!account.blocked,
            approvedAt: account.approvedAt,
            emailVerified: !!account.emailVerified,
          },
          { requireEmailVerified: true },
        )
      )
        throw new CodespaceResourceError(
          "CODESPACE_AUTHORIZATION_REQUIRED",
          "Account access is unavailable",
        );
    },
    assets: loadFileClientAssets,
    lifeProbe: buildFileClientLifeProbe,
    installer: async (provider, config, deadlineAt) =>
      buildFileClientMaintenance(await loadFileClientAssets(provider), config, deadlineAt),
    ...dependencies,
  });
}
