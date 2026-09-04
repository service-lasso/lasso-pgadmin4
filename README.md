# lasso-pgadmin4

`lasso-pgadmin4` packages pgAdmin 4 as a Service Lasso managed service.

It is intended for apps that already include a PostgreSQL service manifest, usually from [`service-lasso/lasso-postgres`](https://github.com/service-lasso/lasso-postgres), and want a local browser UI for inspecting databases.

## Service Contract

- Service ID: `pgadmin4`
- Upstream package: `pgadmin4==9.14`
- Runtime provider: `@python`
- Default UI port: `8510` on canonical endpoint `ui`
- Healthcheck: `GET http://${endpoint.ui.bind}:${endpoint.ui.port}/healthcheck`
- Dependencies: `@python`, `postgres`
- First release platform: Windows `win32`

The service is disabled by default because database ownership, credentials, and retention belong to the consuming app. Copy the released `service.json` into your app's `services/pgadmin4/service.json`, set it enabled when you want it in that app, and include the PostgreSQL service it should connect to.

## Release Artifacts

Pushes to `main` create a GitHub release named with the Service Lasso version pattern:

```text
yyyy.m.d-<shortsha>
```

The release contains:

- `lasso-pgadmin4-9.14-win32.zip`
- `service.json`
- `SHA256SUMS.txt`

## Local Validation

Static validation works on any machine with Node:

```powershell
npm test
```

Full package/start validation requires Python 3.11, matching the current `@python` provider baseline:

```powershell
$env:PYTHON='python'
npm run package
npm run release:verify
```

CI installs Python 3.11 and runs the full package plus healthcheck smoke.

## Runtime Notes

The packaged launcher creates the pgAdmin data directory under `${SERVICE_DATA_PATH}`, injects the packaged Python dependencies into `PYTHONPATH`, exposes `/healthcheck`, and starts pgAdmin on the resolved `ui` network endpoint (`${endpoint.ui.port}`, aliased as `PGADMIN_PORT`).
