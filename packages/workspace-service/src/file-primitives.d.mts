import type { BigIntStats, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export type FileRoot = string | { path: string; dev: number; ino: number };
export type ConfinedFileHandle = FileHandle & { moiraPath?: string };
export interface FileIdentity {
  dev: string;
  ino: string;
  nlink: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  birthtimeNs?: string;
}
export interface DirectoryIdentity {
  dev: string;
  ino: string;
}
export interface ExpectedFile {
  exists: boolean;
  size?: number;
  sha256?: string;
}
export interface FileVersion {
  size: number;
  sha256: string;
  modifiedAt: number;
}
export interface InspectedPath {
  handle: ConfinedFileHandle;
  stat: Stats;
  relative: string;
}
export interface RegularFileStat {
  size: number;
  mode: number;
  mtimeMs: number;
  identity: FileIdentity;
  sha256?: string;
}
export interface RegularFileObservation {
  stat: RegularFileStat;
  path: string;
  handle: ConfinedFileHandle | null;
}
export type CurrentFile = RegularFileObservation & {
  sha256: string;
  stat: RegularFileStat & { sha256: string };
};
export interface ParentDirectory {
  handle: ConfinedFileHandle;
  name: string;
  relative: string;
}
export interface StagedFile extends ParentDirectory {
  root: FileRoot;
  parentIdentity: DirectoryIdentity;
  temporaryName: string;
  current: CurrentFile | null;
  stagingHandle: ConfinedFileHandle;
  identity: FileIdentity;
  size: number;
  sha256: string;
  stream: true;
  closed: boolean;
}

export function failFile(reason: string, message: string): never;
export function readStateJson(path: string): Promise<unknown>;
export function safeRelativePath(value: unknown, allowRoot?: boolean): string;
export function descriptorPath(handle: ConfinedFileHandle, name?: string): string;
export function syncDirectory(handle: FileHandle): Promise<void>;
export function persistDirectory(path: string): Promise<void>;
export function openDirectory(root: FileRoot, relative?: string): Promise<ConfinedFileHandle>;
export function inspectPath(
  root: FileRoot,
  relative: string,
  allowDirectory?: boolean,
): Promise<InspectedPath>;
export function withRegularFile<T extends object>(
  root: FileRoot,
  relative: string,
  work: (handle: ConfinedFileHandle, size: number) => T | Promise<T>,
  options?: { keepOpen?: boolean; inspected?: InspectedPath },
): Promise<T & RegularFileObservation>;
export function hashRegular(handle: FileHandle, size: number): Promise<string>;
export function writeAll(handle: FileHandle, bytes: Uint8Array, position?: number): Promise<void>;
export function version(
  bytes: Uint8Array,
  value: { size: number; mtimeMs: number; sha256?: string },
): FileVersion;
export function version(
  bytes: null,
  value: { size: number; mtimeMs: number; sha256: string },
): FileVersion;
export function validateExpected(expected: ExpectedFile, current: CurrentFile | null): void;
export function fileIdentity(value: BigIntStats): FileIdentity;
export function sameFileIdentity(
  left: FileIdentity | null | undefined,
  right: FileIdentity | null | undefined,
  options?: { afterRename?: boolean },
): boolean;
export function directoryIdentity(handle: FileHandle): Promise<DirectoryIdentity>;
export function sameDirectoryIdentity(
  left: DirectoryIdentity | null | undefined,
  right: DirectoryIdentity | null | undefined,
): boolean;
export function verifyParentIdentity(
  root: FileRoot,
  relative: string,
  expected: DirectoryIdentity,
): Promise<void>;
export function verifyEntryIdentity(
  parentHandle: ConfinedFileHandle,
  name: string,
  expected: FileIdentity,
): Promise<void>;
export function parentDirectory(root: FileRoot, relative: string): Promise<ParentDirectory>;
export function currentFile(
  root: FileRoot,
  relative: string,
  options?: { keepOpen?: boolean; stream?: boolean },
): Promise<CurrentFile | null>;
export function stageStream(
  root: FileRoot,
  path: string,
  source: AsyncIterable<Uint8Array>,
  expected: ExpectedFile,
  marker: string,
): Promise<StagedFile>;
export function cleanupStaged(staged: StagedFile[]): Promise<Error | null>;
export function writeDurableJson(directory: string, name: string, value: unknown): Promise<void>;
export function commitStaged(
  staged: StagedFile[],
  marker: string,
  directory: string,
): Promise<void>;
export function cleanupFileTransaction(directory: string, root: FileRoot): Promise<void>;
export function recoverFileTransaction(directory: string, root: FileRoot): Promise<void>;
