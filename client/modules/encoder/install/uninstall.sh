#!/bin/sh
set -eu

# The Debian package may be shared or pre-existing; it is not tracked by the
# packages provider and must not be removed by this hook.
echo "encoder: leaving the srtla Debian package installed"
