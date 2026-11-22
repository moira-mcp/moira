/** Restart authorization at the provider when returning to login or changing accounts.
 * A new session gets a fresh signed request. Repeated resource values and OAuth state survive. */
export function originalAuthorizationParams(searchParams: URLSearchParams) {
  const params = new URLSearchParams(searchParams);
  for (const key of ["consent_code", "sig", "exp", "ba_iat", "ba_pl", "ba_param"])
    params.delete(key);
  return params;
}
