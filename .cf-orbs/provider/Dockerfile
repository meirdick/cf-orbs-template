# cf-orbs provider image. Runs `amp orb provider /app/dispatch.sh` under tini.
# Build context is the repo root (wrangler image entry: build_context ".."):
#   docker build -f provider/Dockerfile -t cf-orbs-provider .
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

# Pinned Amp CLI. Bump with Renovate or by hand; the provider must match Amp's job protocol.
ARG AMP_CLI_VERSION=0.0.1793390435-g08e9ec

# curl: dispatch.sh. tini: PID 1 that forwards signals and reaps children.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

# @ampcode/cli is proprietary: install it, never vendor it. Its postinstall picks the native binary.
RUN npm install -g "@ampcode/cli@${AMP_CLI_VERSION}" \
  && npm cache clean --force \
  && amp --version

COPY dispatch/dispatch.sh provider/entry.sh /app/
RUN chmod 0755 /app/dispatch.sh /app/entry.sh

ENV AMP_SKIP_UPDATE_CHECK=1 \
  CF_ORBS_URL=http://control.internal

ENTRYPOINT ["/usr/bin/tini", "--", "/app/entry.sh"]
