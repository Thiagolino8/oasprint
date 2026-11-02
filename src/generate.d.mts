/** Resolve roots e outputs relativamente à configuração, sem modificar o ambiente. */
export declare const generateClients: (options?: {
  configPath?: string;
  runtimeImport?: string;
}) => Promise<{ apis: number; updated: number }>;
