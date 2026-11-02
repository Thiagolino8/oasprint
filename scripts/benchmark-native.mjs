import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const [configArgument, ...binaryArguments] = process.argv.slice(2);
if (!configArgument || binaryArguments.length < 2) {
  throw new Error("Uso: node scripts/benchmark-native.mjs <config.json> <antes> <depois> [...]");
}
const configPath = resolve(configArgument);
const config = JSON.parse(await readFile(configPath, "utf8"));
const binaries = binaryArguments.map((path) => resolve(path));
const directory = await mkdtemp(join(tmpdir(), "oasprint-benchmark-"));
try {
  for (const [index, api] of Object.values(config.apis).entries()) {
    assert.ok(
      !/^https?:/.test(api.root),
      "O benchmark exige contratos locais; rede fica fora da medição.",
    );
    api.root = resolve(dirname(configPath), api.root);
    api["x-openapi-ts"] = { output: join(directory, `${index}.d.ts`) };
  }
  const manifest = join(directory, "oasprint.json");
  await writeFile(manifest, JSON.stringify(config));
  const run = (binary) =>
    JSON.parse(
      execFileSync(binary, ["--config", manifest, "--no-env", "--json"], {
        encoding: "utf8",
      }),
    );
  for (const binary of binaries) run(binary);
  const rounds = 30;
  const samples = binaries.map(() => []);
  for (let round = 0; round < rounds; round++) {
    for (let offset = 0; offset < binaries.length; offset++) {
      const index = (round + offset) % binaries.length;
      const start = performance.now();
      const summary = run(binaries[index]);
      samples[index].push(performance.now() - start);
      assert.equal(summary.updated, 0, "Os executáveis produziram outputs diferentes.");
    }
  }
  console.log(
    JSON.stringify(
      {
        platform: `${process.platform}-${process.arch}`,
        apis: Object.keys(config.apis).length,
        rounds,
        method:
          "Processos novos, ordem alternada, JSON local, filesystem aquecido, outputs idênticos; sem rede.",
        results: samples.map((values, index) => {
          const sorted = [...values].sort((a, b) => a - b);
          return {
            binary: basename(binaries[index]),
            medianMs: (sorted[rounds / 2 - 1] + sorted[rounds / 2]) / 2,
            p95Ms: sorted[Math.ceil(rounds * 0.95) - 1],
            samplesMs: values,
          };
        }),
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
