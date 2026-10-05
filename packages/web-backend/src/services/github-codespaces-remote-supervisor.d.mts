export interface SupervisorRepositoryBinding {
  repositoryFullName: string;
  root: string;
  origin: string;
  dev: number;
  ino: number;
}
export function runRequest(
  request: unknown,
  binding?: SupervisorRepositoryBinding,
): Promise<unknown>;
export function runEncoded(encoded: string): Promise<void>;
