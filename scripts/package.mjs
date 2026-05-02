import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serviceVersion = process.env.PGADMIN4_VERSION ?? "9.14";
const targetPlatform = process.env.TARGET_PLATFORM ?? process.platform;

const targets = {
  win32: {
    archiveType: "zip",
    python: process.env.PYTHON ?? "python",
  },
};

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

function runJson(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }

  return JSON.parse(result.stdout);
}

export function assertSupportedPython(command) {
  const version = runJson(command, [
    "-c",
    "import json, sys; print(json.dumps({'major': sys.version_info.major, 'minor': sys.version_info.minor, 'executable': sys.executable}))",
  ]);

  if (version.major !== 3 || version.minor !== 11) {
    throw new Error(
      `lasso-pgadmin4 packages pgAdmin4 with Python 3.11 to match @python; found ${version.major}.${version.minor} at ${version.executable}. Set PYTHON to a Python 3.11 executable.`,
    );
  }
}

function versionedAssetName(version, platform, archiveType) {
  return `lasso-pgadmin4-${version}-${platform}.${archiveType === "zip" ? "zip" : "tar.gz"}`;
}

async function compressPackage(packageRoot, outputPath, archiveType) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });

  if (archiveType === "zip") {
    run("powershell", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path ${JSON.stringify(path.join(packageRoot, "*"))} -DestinationPath ${JSON.stringify(outputPath)} -Force`,
    ]);
    return outputPath;
  }

  run("tar", ["-czf", outputPath, "-C", packageRoot, "."]);
  return outputPath;
}

export async function packagePgadmin4(platform = targetPlatform, version = serviceVersion) {
  const target = targets[platform];
  if (!target) {
    throw new Error(`Unsupported target platform: ${platform}. Supported platforms: ${Object.keys(targets).join(", ")}.`);
  }

  const outputRoot = path.join(repoRoot, "output", "package", version, platform);
  const packageRoot = path.join(outputRoot, "payload");
  const packagesRoot = path.join(packageRoot, "python-packages");
  const appRoot = path.join(packageRoot, "app");
  const outputPath = path.join(repoRoot, "dist", versionedAssetName(version, platform, target.archiveType));

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(packageRoot, { recursive: true });
  await cp(path.join(repoRoot, "app"), appRoot, { recursive: true });

  assertSupportedPython(target.python);
  run(target.python, ["-m", "pip", "install", "--upgrade", "pip"]);
  run(target.python, ["-m", "pip", "install", "--target", packagesRoot, "-r", path.join(appRoot, "requirements.txt")]);

  await cp(path.join(appRoot, "config_local.py"), path.join(packagesRoot, "pgadmin4", "config_local.py"));
  await writeFile(path.join(packageRoot, "lasso-pgadmin4.py"), launcherSource, "utf8");
  await writeFile(
    path.join(packageRoot, "SERVICE-LASSO-PACKAGE.json"),
    `${JSON.stringify(
      {
        serviceId: "pgadmin4",
        upstream: {
          package: "pgadmin4",
          version,
          source: "PyPI",
        },
        migratedFrom: {
          sourcePath: "services/postgredb-admin",
          sourceId: "postgredb-admin",
        },
        packagedBy: "service-lasso/lasso-pgadmin4",
        platform,
        arch: "x64",
        command: "python ./lasso-pgadmin4.py",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  if (platform !== "win32") {
    await chmod(path.join(packageRoot, "lasso-pgadmin4.py"), 0o755);
  }

  await compressPackage(packageRoot, outputPath, target.archiveType);
  console.log(`[lasso-pgadmin4] packaged ${outputPath}`);
  return outputPath;
}

const launcherSource = String.raw`import argparse
import builtins
import os
import shutil
import sys
from pathlib import Path

package_root = Path(__file__).resolve().parent
packages_root = package_root / "python-packages"
app_root = package_root / "app"
pgadmin_root = packages_root / "pgadmin4"

sys.path.insert(0, str(packages_root))
sys.path.insert(0, str(pgadmin_root))

existing_pythonpath = os.environ.get("PYTHONPATH", "")
os.environ["PYTHONPATH"] = os.pathsep.join([str(packages_root), str(pgadmin_root), existing_pythonpath])
os.environ.setdefault("SERVICE_ROOT", os.getcwd())
os.environ.setdefault("DATA_DIR", str(Path(os.environ["SERVICE_ROOT"]) / "runtime" / "data"))
os.environ.setdefault("SERVICE_DATA_PATH", os.environ["DATA_DIR"])
os.environ.setdefault("PGADMIN_HOST", "127.0.0.1")
os.environ.setdefault("PGADMIN_PORT", os.environ.get("SERVICE_PORT", "8510"))
os.environ.setdefault("PGADMIN_SERVER_MODE", "OFF")
os.environ.setdefault("PGADMIN_DEFAULT_EMAIL", "admin@service-lasso.local")
os.environ.setdefault("PGADMIN_DEFAULT_PASSWORD", "service-lasso")
os.environ.setdefault("SCRIPT_NAME", "")
os.environ.setdefault("PYTHONHOME", sys.prefix)

data_dir = Path(os.environ["DATA_DIR"]).resolve()

def prepare():
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "sessions").mkdir(parents=True, exist_ok=True)
    (data_dir / "storage").mkdir(parents=True, exist_ok=True)
    config_target = pgadmin_root / "config_local.py"
    if not config_target.exists():
        shutil.copyfile(app_root / "config_local.py", config_target)
    if not (pgadmin_root / "pgAdmin4.py").exists():
        raise RuntimeError(f"pgAdmin4.py not found under {pgadmin_root}")
    print(f"[lasso-pgadmin4] prepared data directory {data_dir}")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--setup", action="store_true")
    args = parser.parse_args()

    prepare()
    if args.setup:
        return

    os.environ["APPDATA"] = str(data_dir)
    os.environ["CommonProgramFiles"] = str(packages_root)
    builtins.SERVER_MODE = False

    os.chdir(pgadmin_root)
    from pgAdmin4 import app as application

    @application.route("/healthcheck")
    def service_lasso_healthcheck():
        return {"ok": True, "service": "pgadmin4"}, 200

    host = os.environ.get("PGADMIN_HOST", "127.0.0.1")
    port = int(os.environ.get("SERVICE_PORT") or os.environ.get("PGADMIN_PORT") or "8510")
    application.run(host=host, port=port)

if __name__ == "__main__":
    main()
`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await packagePgadmin4();
}
