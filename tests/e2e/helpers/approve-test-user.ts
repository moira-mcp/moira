interface FeaturesEnvelope {
  data?: { features?: { accountApproval?: boolean } };
}

interface UsersEnvelope {
  data?: {
    users?: Array<{ id: string; email: string; approvedAt?: string | null }>;
  };
}

/**
 * Make a fixture user product-ready under the deployment's actual admission
 * policy. SaaS needs no approval transition; self-host does. The caller owns
 * email verification separately because it remains an independent fact.
 */
export async function approveTestUserIfRequired(
  fetchUrl: string,
  email: string,
  adminCookieHeader: string,
): Promise<string | undefined> {
  const featuresResponse = await fetch(`${fetchUrl}/api/features`);
  if (!featuresResponse.ok) {
    throw new Error(`Feature lookup failed: ${featuresResponse.status}`);
  }
  const features = (await featuresResponse.json()) as FeaturesEnvelope;

  const usersResponse = await fetch(
    `${fetchUrl}/api/admin/users?search=${encodeURIComponent(email)}&limit=10`,
    { headers: { Cookie: adminCookieHeader } },
  );
  if (!usersResponse.ok) {
    throw new Error(`Admin user lookup failed: ${usersResponse.status}`);
  }
  const users = (await usersResponse.json()) as UsersEnvelope;
  const user = users.data?.users?.find((candidate) => candidate.email === email);
  if (!user) return undefined;

  if (features.data?.features?.accountApproval && user.approvedAt === null) {
    const approvalResponse = await fetch(`${fetchUrl}/api/admin/users/${user.id}/approve`, {
      method: "POST",
      headers: { Cookie: adminCookieHeader },
    });
    if (!approvalResponse.ok) {
      throw new Error(`Admin approval failed: ${approvalResponse.status}`);
    }
  }

  return user.id;
}
