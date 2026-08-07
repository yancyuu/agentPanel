declare module 'pidusage' {
  interface PidUsageStat {
    pid: number | string;
    cpu: number;
    memory: number;
    ppid: number;
    uid: number;
    gid: number;
    starttime: number;
    elapsed: number;
    timestamp: number;
    ctime: number;
    rssBytes?: number;
  }

  function pidusage(
    pids: (number | string)[],
    options?: { maxage?: number }
  ): Promise<Record<string, PidUsageStat>>;
  function pidusage(pid: number | string, options?: { maxage?: number }): Promise<PidUsageStat>;

  export = pidusage;
}
