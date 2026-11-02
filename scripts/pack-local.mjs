import { execFileSync } from "node:child_process";
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

execFileSync("pnpm", ["run", "check"], { stdio: "inherit" });
const staging = ".cache/standalone";
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const platforms = (await readdir("npm", { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
delete manifest.optionalDependencies;
delete manifest.scripts;
await writeFile(`${staging}/package.json`, JSON.stringify(manifest, null, 2));
await Promise.all(
  ["dist", "README.md", "LICENSE"].map((file) =>
    cp(file, `${staging}/${file}`, { recursive: true }),
  ),
);
// Require every supported platform: the vendored package also serves other dev hosts.
await Promise.all(
  platforms.map(async (platform) => {
    await access(
      `npm/${platform}/bin/${platform.startsWith("win32-") ? "oasprint.exe" : "oasprint"}`,
    );
    await cp(`npm/${platform}/bin`, `${staging}/dist/bin/${platform}`, { recursive: true });
  }),
);
execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", path.resolve(".")], {
  cwd: staging,
  stdio: "inherit",
});
