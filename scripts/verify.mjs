import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSupportedPython, packagePgadmin4 } from "./package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.TARGET_PLATFORM ?? process.platform;
const serviceVersion = process.env.PGADMIN4_VERSION ?? "9.14";
const python = process.env.PYTHON ?? "python";
const staticOnly = process.argv.includes("--static");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve loopback port.")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(port, timeoutMs = 180_000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthcheck`);
      if (response.status === 200) {
        return;
      }
      lastError = new Error(`Unexpected health status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }

  throw lastError ?? new Error(`Timed out waiting for pgAdmin4 on ${port}.`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    sleep(10_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

async function staticChecks() {
  const serviceManifest = JSON.parse(await readFile(path.join(repoRoot, "service.json"), "utf8"));
  const requirements = await readFile(path.join(repoRoot, "app", "requirements.txt"), "utf8");

  if (serviceManifest.id !== "pgadmin4" || serviceManifest.version !== serviceVersion) {
    throw new Error(`Unexpected service manifest identity: ${JSON.stringify({ id: serviceManifest.id, version: serviceManifest.version })}`);
  }

  if (serviceManifest.execservice !== "@python" || !serviceManifest.depend_on?.includes("@python")) {
    throw new Error("pgAdmin4 must run through and depend on @python.");
  }

  if (!serviceManifest.depend_on?.includes("postgres")) {
    throw new Error("pgAdmin4 must declare its app-owned postgres dependency.");
  }

  const healthchecks = serviceManifest.healthchecks;
  if (serviceManifest.healthcheck !== undefined) {
    throw new Error("pgAdmin4 service.json must use canonical healthchecks[] instead of singular healthcheck.");
  }
  if (serviceManifest.ports !== undefined || serviceManifest.urls !== undefined) {
    throw new Error("pgAdmin4 service.json must use canonical endpoints[] instead of ports or urls.");
  }

  if (!Array.isArray(healthchecks) || healthchecks.length !== 1) {
    throw new Error(`pgAdmin4 service.json must declare exactly one canonical healthcheck: ${JSON.stringify(healthchecks)}`);
  }

  const [httpHealth] = healthchecks;
  const endpoints = Array.isArray(serviceManifest.endpoints) ? serviceManifest.endpoints : [];
  const ui = endpoints.find((entry) => entry && entry.id === "ui");
  const uiUrl = endpoints.find((entry) => entry && entry.id === "ui_url");
  const healthUrl = endpoints.find((entry) => entry && entry.id === "health");
  if (
    httpHealth.id !== "http-health" ||
    httpHealth.type !== "http" ||
    httpHealth.url !== "http://${endpoint.ui.bind}:${endpoint.ui.port}/healthcheck" ||
    httpHealth.expected_status !== 200 ||
    httpHealth.retries !== 180 ||
    httpHealth.interval !== 500 ||
    endpoints.length !== 3 ||
    ui?.kind !== "network" ||
    ui?.transport !== "tcp" ||
    ui?.protocol !== "http" ||
    ui?.bind !== "127.0.0.1" ||
    ui?.port?.default !== 8510 ||
    ui?.port?.strategy !== "preferred" ||
    uiUrl?.kind !== "url" ||
    uiUrl?.target !== "ui" ||
    uiUrl?.url !== "http://${endpoint.ui.bind}:${endpoint.ui.port}/" ||
    healthUrl?.kind !== "url" ||
    healthUrl?.target !== "ui" ||
    healthUrl?.url !== "http://${endpoint.ui.bind}:${endpoint.ui.port}/healthcheck" ||
    serviceManifest.env?.PGADMIN_HOST !== "${endpoint.ui.bind}" ||
    serviceManifest.env?.PGADMIN_PORT !== "${endpoint.ui.port}" ||
    serviceManifest.globalenv?.PGADMIN_URL !== "${endpoint.ui_url.url}"
  ) {
    throw new Error(
      `pgAdmin4 service.json health/endpoints drifted: ${JSON.stringify({
        healthchecks,
        endpoints,
        env: serviceManifest.env,
        globalenv: serviceManifest.globalenv,
      })}`,
    );
  }

  if (serviceManifest.setup?.steps?.["prepare-data"]?.execservice !== "@python") {
    throw new Error("pgAdmin4 service.json must include the provider-backed prepare-data setup step.");
  }

  if (!requirements.includes(`pgadmin4==${serviceVersion}`)) {
    throw new Error(`requirements.txt must pin pgadmin4==${serviceVersion}.`);
  }
}

await staticChecks();

if (staticOnly) {
  console.log("[lasso-pgadmin4] static verification passed");
  process.exit(0);
}

assertSupportedPython(python);
const artifact = await packagePgadmin4(platform, serviceVersion);
const verifyRoot = path.join(repoRoot, "output", "verify", serviceVersion, platform);
const serviceRoot = path.join(verifyRoot, "service");
const extractRoot = path.join(serviceRoot, ".state", "extracted", "current");
const metadataPath = path.join(extractRoot, "SERVICE-LASSO-PACKAGE.json");
const port = await reserveLoopbackPort();

await rm(verifyRoot, { recursive: true, force: true });
await mkdir(extractRoot, { recursive: true });

if (artifact.endsWith(".zip")) {
  run("powershell", [
    "-NoLogo",
    "-NoProfile",
    "-Command",
    `Expand-Archive -Path ${JSON.stringify(artifact)} -DestinationPath ${JSON.stringify(extractRoot)} -Force`,
  ]);
} else {
  run("tar", ["-xzf", artifact, "-C", extractRoot]);
}

const packageMetadata = JSON.parse(await readFile(metadataPath, "utf8"));
if (
  packageMetadata.serviceId !== "pgadmin4" ||
  packageMetadata.upstream?.version !== serviceVersion ||
  packageMetadata.packagedBy !== "service-lasso/lasso-pgadmin4" ||
  packageMetadata.platform !== platform
) {
  throw new Error(`Unexpected package metadata: ${JSON.stringify(packageMetadata)}`);
}

run(python, ["./lasso-pgadmin4.py", "--setup"], {
  cwd: extractRoot,
  env: {
    ...process.env,
    SERVICE_ROOT: serviceRoot,
    SERVICE_DATA_PATH: path.join(serviceRoot, "runtime", "data"),
    DATA_DIR: path.join(serviceRoot, "runtime", "data"),
  },
});

const child = spawn(python, ["./lasso-pgadmin4.py"], {
  cwd: extractRoot,
  env: {
    ...process.env,
    SERVICE_ROOT: serviceRoot,
    SERVICE_DATA_PATH: path.join(serviceRoot, "runtime", "data"),
    DATA_DIR: path.join(serviceRoot, "runtime", "data"),
    SERVICE_PORT: String(port),
    PGADMIN_HOST: "127.0.0.1",
    PGADMIN_PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout?.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForHealth(port);
  console.log("[lasso-pgadmin4] verification passed");
} catch (error) {
  console.error("[lasso-pgadmin4] stdout:");
  console.error(stdout);
  console.error("[lasso-pgadmin4] stderr:");
  console.error(stderr);
  throw error;
} finally {
  await stopChild(child);
}
