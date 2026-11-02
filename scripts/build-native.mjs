import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir } from "node:fs/promises";

const targets = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};
const platform = `${process.platform}-${process.arch}`;
const target = targets[platform];
if (!target) throw new Error(`Plataforma sem build nativo: ${platform}`);
execFileSync(
  "cargo",
  [
    "+1.99.1",
    "build",
    "--manifest-path",
    "native/Cargo.toml",
    "--locked",
    "--release",
    "--target",
    target,
    "--target-dir",
    ".cache/native-target",
  ],
  { stdio: "inherit" },
);
const executable = process.platform === "win32" ? "oasprint.exe" : "oasprint";
const directory = `npm/${platform}/bin`;
await mkdir(directory, { recursive: true });
await copyFile(
  `.cache/native-target/${target}/release/${executable}`,
  `${directory}/${executable}`,
);
await chmod(`${directory}/${executable}`, 0o755);
await copyFile("LICENSE", `npm/${platform}/LICENSE`);
