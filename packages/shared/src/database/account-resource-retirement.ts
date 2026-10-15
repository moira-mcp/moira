export class AccountResourceRetirementRequiredError extends Error {
  readonly code = "ACCOUNT_RESOURCE_RETIREMENT_PENDING";
  constructor() {
    super("Account managed resource retirement remains pending");
    this.name = "AccountResourceRetirementRequiredError";
  }
}

/** Stopping a managed resource does not dispose its persistent storage or ownership. */
export function assertAccountResourcesRetired(resources: Iterable<{ state: string }>): void {
  for (const resource of resources)
    if (resource.state !== "deleted") throw new AccountResourceRetirementRequiredError();
}
