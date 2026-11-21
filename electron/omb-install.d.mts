export declare const ombInstallPath: (home: string) => string;
export declare function copyOmb(options: { source: string; home: string }): { path: string; state: "installed" | "updated" | "linked" };
export declare function findNode(searchPath: string | undefined, options?: { exists?: (file: string) => boolean }): { path: string; found: boolean };
export declare function loadOmb(file: string): Promise<{ main(argv: string[], overrides?: Record<string, unknown>): Promise<number> }>;
export declare function runOmb(
  omb: { main(argv: string[], overrides?: Record<string, unknown>): Promise<number> },
  argv: string[],
  options: { env: Record<string, string | undefined>; home: string; nodePath: string; selfPath: string; hide?: string[] },
): Promise<{ code: number; data: any; error: string | null }>;
