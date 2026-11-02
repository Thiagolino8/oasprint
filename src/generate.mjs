import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nativeBinary } from "./native.mjs";

const exec = promisify(execFile);
export const generateClients = async ({
  configPath = "oasprint.json",
  runtimeImport = "oasprint",
} = {}) => {
  const { stdout } = await exec(nativeBinary(), [
    "--config",
    configPath,
    "--runtime-import",
    runtimeImport,
    "--no-env",
    "--json",
  ]);
  return JSON.parse(stdout);
};
