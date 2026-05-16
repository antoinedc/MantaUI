#!/usr/bin/env bash
set -euo pipefail
# Build the React renderer straight into mobile/www/.
cd "$(dirname "$0")/.."
npm run build:mobile
