import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const platform = `${process.platform}-${process.arch}`;
const executable = process.platform === "win32" ? "oasprint.exe" : "oasprint";
export const nativeBinary = () => {
  const bundled = fileURLToPath(new URL(`./bin/${platform}/${executable}`, import.meta.url));
  if (existsSync(bundled)) return bundled;
  try {
    return createRequire(import.meta.url).resolve(`oasprint-${platform}/bin/${executable}`);
  } catch {
    throw new Error(
      `oasprint: binário ${platform} ausente. Reinstale com dependências opcionais habilitadas.`,
    );
  }
};
