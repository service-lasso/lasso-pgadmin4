# pgAdmin4 Service

This repo owns the Service Lasso manifest and release artifact for pgAdmin 4.

## What Gets Packaged

The release package contains:

- `lasso-pgadmin4.py`, the Service Lasso launcher
- `python-packages/`, populated from `app/requirements.txt`
- `app/config_local.py`, copied into the packaged pgAdmin module during packaging
- `app/servers.json`, retained as app configuration reference
- `SERVICE-LASSO-PACKAGE.json`, package provenance metadata

## Service Lasso Behavior

The service runs through `@python`, so consuming apps must include the `@python` provider manifest.

The `prepare-data` setup step runs `lasso-pgadmin4.py --setup` through `@python`. It creates the service data directories and validates that the packaged pgAdmin modules are present.

The start command runs `lasso-pgadmin4.py` through `@python`. The launcher injects packaged dependencies into `PYTHONPATH`, exposes `/healthcheck`, and starts pgAdmin on `${SERVICE_PORT}`.

## Consumer Responsibilities

Consumers own:

- whether `pgadmin4` is enabled
- PostgreSQL service selection and credentials
- retained pgAdmin data under `${SERVICE_DATA_PATH}`
- any app-specific server registration/import workflow
