import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const root = await mkdtemp(join(tmpdir(), "miko-clean-install-"));
const artifacts = resolve(process.argv[2] ?? "artifacts");
const env = { ...process.env, MIKO_HOME: join(root, "home"), PASEO_HOME: undefined };
let started = false;
try {
  const files = (await readdir(artifacts))
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => join(artifacts, file));
  assert.equal(files.length, 8);
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...files]);
  const cli = join(root, "node_modules/.bin/miko");
  assert.match(await run(cli, ["--help"]), /Usage: miko/);
  assert.equal((await run(cli, ["--version"])).trim(), "0.8.0-miko.1");
  const manifest = JSON.parse(
    await readFile(join(root, "node_modules/@mikoagents/cli/package.json"), "utf8"),
  );
  assert.equal(manifest.dependencies["@mikoagents/server"], "0.8.0-miko.1");
  assert.equal(manifest.dependencies["@getpaseo/server"], undefined);
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve) => server.close(resolve));
  await run(cli, [
    "daemon",
    "start",
    "--listen",
    `127.0.0.1:${address.port}`,
    "--no-relay",
    "--json",
  ]);
  started = true;
  const status = await run(cli, ["daemon", "status", "--json"]);
  assert.match(status, /running/);
  const backends = JSON.parse(await run(cli, ["backend", "ls", "--json"]));
  assert.deepEqual(backends, [{ id: "local", type: "local" }]);
  await run(cli, ["daemon", "stop", "--json"]);
  started = false;
  process.stdout.write(
    "Clean install: branded CLI, isolated supervisor startup/status/shutdown and local backend passed.\n",
  );
} finally {
  if (started)
    await run(join(root, "node_modules/.bin/miko"), ["daemon", "stop", "--force", "--json"]).catch(
      () => {},
    );
  await rm(root, { recursive: true, force: true });
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timed out: ${command}`));
    }, 120_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${command} exited ${code}: ${stderr.slice(-4000)}`));
      else resolve(stdout);
    });
  });
}
