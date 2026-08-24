/**
 * The effects boundary: where file and shell operations run. The harness and
 * the built-in tools talk to an ExecutionEnv and nothing else, so a host
 * chooses the placement (this machine, a VM, a container) by supplying an
 * implementation. Every operation returns a Result and never throws; the
 * abort signal comes from the Context passed last.
 *
 * Based on https://github.com/earendil-works/pi/blob/dev/packages/agent/src/harness/types.ts
 * Synced with pi 7ebf9087e.
 */
import type { Context } from "../context.ts";
import type { Result } from "../result.ts";

/** Kind of filesystem object as addressed by a {@link FileSystem}. Symlinks are not followed automatically. */
export type FileKind = "file" | "directory" | "symlink";

/** Stable, backend-independent file error codes returned by {@link FileSystem} file operations. */
export type FileErrorCode =
  | "aborted"
  | "not_found"
  | "permission_denied"
  | "not_directory"
  | "is_directory"
  | "invalid"
  | "not_supported"
  | "unknown";

/** Error returned by {@link FileSystem} file operations. */
export class FileError extends Error {
  /** Backend-independent error code. */
  public code: FileErrorCode;
  /** Absolute addressed path associated with the failure, when available. */
  public path?: string;

  constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FileError";
    this.code = code;
    this.path = path;
  }
}

/** Stable, backend-independent execution error codes returned by {@link Shell.exec}. */
export type ExecutionErrorCode =
  | "aborted"
  | "timeout"
  | "shell_unavailable"
  | "spawn_error"
  | "callback_error"
  | "unknown";

/** Error returned by {@link Shell.exec}. */
export class ExecutionError extends Error {
  /** Backend-independent error code. */
  public code: ExecutionErrorCode;

  constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ExecutionError";
    this.code = code;
  }
}

/** Metadata for one filesystem object in a {@link FileSystem}. */
export interface FileInfo {
  /** Basename of {@link path}. */
  name: string;
  /** Absolute, syntactically normalized addressed path in the execution environment. Symlinks are not followed. */
  path: string;
  /** Object kind. Symlink targets are not followed; use {@link FileSystem.realPath} explicitly. */
  kind: FileKind;
  /** Size in bytes for the addressed filesystem object. */
  size: number;
  /** Modification time as milliseconds since Unix epoch. */
  mtimeMs: number;
}

/**
 * Filesystem capability used by the harness.
 *
 * Paths passed to methods may be absolute or relative to {@link cwd}. Paths returned by file operations are
 * addressed paths in the filesystem namespace, but do not resolve symlinks unless returned by
 * {@link realPath}.
 *
 * Operation methods must never throw or reject. All filesystem failures, including unexpected backend
 * failures, must be encoded in the returned {@link Result}. Implementations must preserve this invariant.
 */
export interface FileSystem {
  /** Current working directory for relative paths. */
  cwd: string;

  /** Return an absolute addressed path without requiring it to exist and without resolving symlinks. */
  absolutePath(path: string, context: Context): Promise<Result<string, FileError>>;
  /** Join path segments in the filesystem namespace without requiring the result to exist. */
  joinPath(parts: string[], context: Context): Promise<Result<string, FileError>>;
  /** Read a UTF-8 text file. */
  readTextFile(path: string, context: Context): Promise<Result<string, FileError>>;
  /** Read UTF-8 text lines. Implementations should stop once `maxLines` lines have been read. */
  readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>>;
  /** Read a binary file. */
  readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>>;
  /** Create or overwrite a file, creating parent directories when supported. */
  writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>>;
  /** Create or append to a file, creating parent directories when supported. */
  appendFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>>;
  /** Atomically rename a file, replacing the destination when it exists. Does not copy across filesystems. */
  renameFile(
    sourcePath: string,
    destinationPath: string,
    context: Context,
  ): Promise<Result<void, FileError>>;
  /** Return metadata for the addressed path without following symlinks. */
  fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>>;
  /** List direct children of a directory without following symlinks. */
  listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>>;
  /** Return the real path for an existing path, resolving symlinks where supported. */
  realPath(path: string, context: Context): Promise<Result<string, FileError>>;
  /** Return false for missing paths. Other errors, such as permission failures, return a {@link FileError}. */
  exists(path: string, context: Context): Promise<Result<boolean, FileError>>;
  /** Create a directory. Defaults to `recursive: true`. */
  createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>>;
  /** Remove a file or directory. Defaults to `recursive: false` and `force: false`. */
  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>>;
  /** Create a temporary directory and return its absolute path. Defaults to `prefix: "tmp-"`. */
  createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>>;
  /** Create a temporary file and return its absolute path. Defaults to `prefix: ""` and `suffix: ""`. */
  createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>>;

  /** Release filesystem resources. Must be best-effort and must not throw or reject. */
  cleanup(context: Context): Promise<void>;
}

/** Options for {@link Shell.exec}. */
export interface ShellExecOptions {
  /** Working directory for the command. Relative paths resolve against {@link FileSystem.cwd}, which is also the default. */
  cwd?: string;
  /** Environment variables for the command. Values override inherited defaults when `inheritEnv` is true. */
  env?: Record<string, string>;
  /** Whether to inherit the execution environment's default variables. Defaults to true. */
  inheritEnv?: boolean;
  /** Timeout in seconds. Implementations return a timeout error when the command exceeds it. Defaults to no timeout. */
  timeout?: number;
  /** Called with stdout chunks as they are produced. */
  onStdout?: (chunk: string, context: Context) => void;
  /** Called with stderr chunks as they are produced. */
  onStderr?: (chunk: string, context: Context) => void;
}

/** Shell execution capability used by the harness. */
export interface Shell {
  /** Execute a shell command in {@link FileSystem.cwd} unless `options.cwd` is provided. */
  exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>>;
  /** Release shell resources. Must be best-effort and must not throw or reject. */
  cleanup(context: Context): Promise<void>;
}

/** Filesystem and process execution environment used by the harness. */
export type ExecutionEnv = FileSystem & Shell;
