#!/bin/bash
set -o pipefail

# General-purpose deploy/redeploy script for this backend. Part of the
# create-better-auth-app template -- ships in every scaffolded project's
# backend repo automatically (it's just a file in this repo, no CLI change
# needed for it to propagate), not specific to any one project.
#
# Mirrors the suite-wide redeploy-websites.sh's calling convention
# (positional args, manual-env-file > Infisical > standard secrets
# fallback) so a Jenkins pipeline for this repo can call it the same way an
# existing website pipeline calls redeploy-websites.sh -- see README.md's
# "Deployment" section for a template Jenkinsfile. Unlike
# redeploy-websites.sh (a single `docker run`), this is docker-compose
# based (build + a `db` dependency), so it isn't just a copy of that
# script -- lives inside this repo (not two directories up) since a Jenkins
# job that only checks out this one repo has no sibling directory to put a
# shared script in.
#
# Usage:
#   ./deploy.sh                                                  interactive menu
#   ./deploy.sh deploy [port] [infisical-project-id] [infisical-domain] [env-file]
#   ./deploy.sh restart [port]                                   no rebuild
#   ./deploy.sh seed-admin                                       interactive, never reads .env

cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

INFISICAL_DOMAIN_DEFAULT="https://app.infisical.com/api"

# Complains when .env.example exists but .env doesn't -- offers to copy it
# on the spot instead of failing deep inside `docker compose build` with a
# confusing missing-var error. Skips the prompt (defaults to "no") when
# stdin isn't a terminal (CI/non-interactive `./deploy.sh deploy`).
check_env_file() {
  if [ -f ".env.example" ] && [ ! -f ".env" ]; then
    echo "Warning: .env is missing, but .env.example exists."
    if [ -t 0 ]; then
      read -r -p "Copy .env.example to .env now? [y/N] " reply
    else
      reply="n"
    fi
    if [[ "$reply" =~ ^[Yy]$ ]]; then
      cp .env.example .env
      echo "Copied. Edit .env with real values before this deploy is actually usable."
    else
      echo "Continuing without .env -- this will likely fail or run with placeholder defaults."
    fi
  fi
}

deploy() {
  local port="${1:-3000}"
  local infisical_project_id="$2"
  local infisical_domain="${3:-$INFISICAL_DOMAIN_DEFAULT}"
  local env_file="$4"

  if [ -n "$env_file" ] && [ -f "$env_file" ]; then
    echo "Deployment mode: manual env file ($env_file) -- copying to .env"
    # compose.yml's backend service reads `env_file: - .env` (a literal
    # path, not parameterized) -- secrets have to actually become .env, not
    # just be passed via a --env-file flag (that only affects ${VAR}
    # interpolation inside compose.yml itself, not what lands in the
    # container).
    cp "$env_file" .env
  elif [ -n "$infisical_project_id" ]; then
    echo "Deployment mode: Infisical (project: $infisical_project_id) -- writing .env"
    if ! infisical export --silent --domain "$infisical_domain" --projectId "$infisical_project_id" --env=prod --format=dotenv | sed "s/=['\"]/=/;s/['\"]$//" > .env; then
      echo "Error: Infisical connection failed. Using existing .env as-is."
    fi
  else
    check_env_file
    echo "Deployment mode: existing .env"
  fi

  # PORT drives compose.yml's "${BIND_HOST:-127.0.0.1}:${PORT:-3000}:${PORT:-3000}"
  # mapping -- host port, container's own listen port, and the healthcheck
  # all move together, so this is safe to change per deploy without a
  # mismatch. compose.yml's own default is already loopback-only; no need
  # to set BIND_HOST here too unless the caller's environment overrides it
  # for a specific reason (e.g. LAN-based mobile-device testing).
  echo "Recreating backend stack on port $port (down, build --no-cache, up -d) -- brief downtime, including the db container..."
  PORT="$port" docker compose down && PORT="$port" docker compose build --no-cache backend && PORT="$port" docker compose up -d
}

restart() {
  local port="${1:-3000}"
  echo "Restarting backend stack on port $port (no rebuild)..."
  PORT="$port" docker compose up -d
}

# `npm run seed:admin` shells out to `tsx`, a devDependency -- the
# production image only ships compiled `dist/` (no devDependencies, no
# package.json even), so that command fails with "tsx: not found" both
# inside the container and on the host. Runs the compiled script directly
# against the already-running container instead.
#
# Prompts for email/password/name instead of reading ADMIN_EMAIL/
# ADMIN_PASSWORD/ADMIN_NAME out of .env -- those are meant to be deleted
# from the environment after the first admin exists (see .env.example's own
# comment on them), so this doesn't depend on them being there at all.
# `docker compose exec -e VAR=value` injects them for just this one exec
# call, without touching the container's baseline env or ever writing to
# .env. Safe to run any time -- idempotent, promotes an existing account
# instead of erroring if the email already exists (see README's Operations).
seed_admin() {
  if [ ! -t 0 ]; then
    echo "seed-admin needs an interactive terminal (email/password prompts) -- run it directly, not from CI."
    return 1
  fi

  read -r -p "Admin email: " admin_email
  read -r -s -p "Admin password (min 8 chars): " admin_password
  echo ""
  read -r -p "Admin name [Admin]: " admin_name
  admin_name="${admin_name:-Admin}"

  if [ -z "$admin_email" ] || [ -z "$admin_password" ]; then
    echo "Email and password are required. Aborting."
    return 1
  fi
  if [ "${#admin_password}" -lt 8 ]; then
    echo "Password must be at least 8 characters. Aborting."
    return 1
  fi

  docker compose exec -e ADMIN_EMAIL="$admin_email" -e ADMIN_PASSWORD="$admin_password" -e ADMIN_NAME="$admin_name" backend node dist/scripts/seed-admin.js
}

# Non-interactive mode: ./deploy.sh <target> [args...]
if [ -n "$1" ]; then
  target="$1"
  shift
  case "$target" in
    deploy) deploy "$@" ;;
    restart) restart "$@" ;;
    seed-admin) seed_admin ;;
    *)
      echo "Usage: $0 [deploy [port] [infisical-project-id] [infisical-domain] [env-file] | restart [port] | seed-admin]"
      exit 1
      ;;
  esac
  exit $?
fi

# Interactive menu
while true; do
  echo ""
  echo "Backend deploy"
  echo "[1] Deploy (build + up -- brief downtime, incl. db)"
  echo "[2] Restart, no rebuild"
  echo "[3] Seed/promote admin account (idempotent, safe to re-run)"
  echo "[0] Exit"
  read -r -p "> " choice
  case "$choice" in
    1)
      read -r -p "Port [3000]: " port
      read -r -p "Infisical project ID (blank to skip): " infisical_id
      deploy "${port:-3000}" "$infisical_id"
      ;;
    2)
      read -r -p "Port [3000]: " port
      restart "${port:-3000}"
      ;;
    3) seed_admin ;;
    0) exit 0 ;;
    *) echo "Invalid choice." ;;
  esac
done
