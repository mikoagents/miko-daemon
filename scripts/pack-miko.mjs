import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(process.argv[2] ?? join(root, "artifacts"));
const packages = [
  "highlight",
  "plugin",
  "relay",
  "protocol",
  "client",
  "execution-protocol",
  "server",
  "cli",
];
const version = "0.8.0-miko.1";
const staging = await mkdtemp(join(tmpdir(), "miko-pack-"));
await mkdir(output, { recursive: true });
try {
  for (const name of packages) {
    const source = join(root, "packages", name),
      destination = join(staging, name);
    await mkdir(destination);
    const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    for (const directory of ["dist", ...(name === "cli" ? ["bin"] : [])])
      await cp(join(source, directory), join(destination, directory), { recursive: true });
    for (const file of ["LICENSE", "NOTICE"]) {
      try {
        await cp(join(root, file), join(destination, file));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    manifest.name = `@mikoagents/${name}`;
    if (name !== "execution-protocol") manifest.version = version;
    delete manifest.private;
    delete manifest.scripts;
    delete manifest.devDependencies;
    manifest.repository = {
      type: "git",
      url: "git+https://github.com/mikoagents/miko-daemon.git",
      directory: `packages/${name}`,
    };
    manifest.homepage = "https://github.com/mikoagents/miko-daemon";
    for (const dependencies of [
      manifest.dependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ]) {
      if (!dependencies) continue;
      for (const [key, value] of Object.entries(dependencies)) {
        if (key.startsWith("@getpaseo/") && packages.includes(key.slice(10))) {
          delete dependencies[key];
          dependencies[key.replace("@getpaseo/", "@mikoagents/")] = version;
        } else if (typeof value === "string" && value.startsWith("file:"))
          throw new Error(`Local dependency in ${manifest.name}: ${key}`);
      }
    }
    if (name === "cli") {
      manifest.bin = { miko: "bin/miko" };
      await rm(join(destination, "bin/paseo"), { force: true });
    }
    await writeFile(join(destination, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    await rewrite(destination);
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", output], {
      cwd: destination,
      encoding: "utf8",
    });
    if (packed.status !== 0) throw new Error(packed.stderr);
    process.stdout.write(packed.stdout);
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
async function rewrite(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await rewrite(path);
    else if (/\.(js|mjs|cjs|ts|json)$/.test(entry.name) || entry.name === "miko") {
      const original = await readFile(path, "utf8");
      let text = original;
      for (const name of packages)
        text = text.replaceAll(`@getpaseo/${name}`, `@mikoagents/${name}`);
      if (text !== original) await writeFile(path, text);
    }
  }
}
