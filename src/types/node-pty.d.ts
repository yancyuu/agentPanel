/**
 * Ambient type stub for the optional native addon `node-pty`.
 *
 * `node-pty` is an OPTIONAL runtime dependency — `ClaudeDoctorProbe` loads it via
 * a guarded `require()` and degrades gracefully when it is absent. It is NOT in
 * `package.json`, so without this declaration `import type { IPty } from 'node-pty'`
 * fails typecheck. The shapes here cover only the surface the probe uses.
 */
declare module 'node-pty' {
  export interface IPty {
    pid: number;
    write(data: string): void;
    resize(columns: number, rows: number): void;
    kill(signal?: string): void;
    onData: (listener: (data: string) => void) => void;
    onExit: (
      listener: ({ exitCode, signal }: { exitCode: number; signal?: number }) => void
    ) => void;
  }

  export interface ISpawnOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  }

  export function spawn(file: string, args: string[] | string, options: ISpawnOptions): IPty;
}
