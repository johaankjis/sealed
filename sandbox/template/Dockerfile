# Proposed template: sealed-python-duckdb-1-5-4 (NOT built/verified yet).
# Base shown by the CreateOS template form on 2026-10-17.
# Preserve the provider's boot/agent configuration; single stage, no COPY/ADD.
FROM bhautikchudasama/fc-base:debian-1

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates coreutils \
    && /usr/bin/python3 -m venv /opt/sealed-python \
    && /opt/sealed-python/bin/python3 -m pip install --no-cache-dir --only-binary=:all: duckdb==1.5.4 \
    && printf '#!/bin/sh\nexec /opt/sealed-python/bin/python3 "$@"\n' > /usr/local/bin/python3 \
    && chmod 0755 /usr/local/bin/python3 \
    && /usr/local/bin/python3 -I -c 'import duckdb; assert duckdb.__version__ == "1.5.4"; assert duckdb.sql("SELECT 42").fetchone() == (42,)' \
    && timeout --version \
    && rm -rf /var/lib/apt/lists/*
