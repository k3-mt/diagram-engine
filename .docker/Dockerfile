# Sandbox for unattended Topology build runs.
# Nothing here is deployed. This exists so `--dangerously-skip-permissions`
# is contained to a throwaway filesystem rather than your home directory.

FROM node:20-bookworm-slim

ARG UID=1000
ARG GID=1000

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl gnupg jq procps \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg \
      -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/*

# docker CLI only, no socket. `docker compose config` validates a compose file
# client-side, which is all P3-01 needs. Nothing here can start a container.

RUN npm install -g @anthropic-ai/claude-code

# match the host user so files written into the bind mount stay yours
# Reuse an existing group/user when the host ids collide with ones the base
# image already has. macOS hosts are typically 501:20, and GID 20 is `dialout`
# on Debian, so an unconditional groupadd fails the build.
RUN if ! getent group "$GID" >/dev/null; then groupadd -g "$GID" dev; fi \
 && if ! getent passwd "$UID" >/dev/null; then \
      useradd -u "$UID" -g "$GID" -m -s /bin/bash dev; \
    fi \
 && HOME_DIR="$(getent passwd "$UID" | cut -d: -f6)" \
 && mkdir -p "$HOME_DIR" && chown "$UID:$GID" "$HOME_DIR"
# Pre-create the node_modules mount points and give them to the build user.
# Docker initialises an empty named volume from the image's content at that
# path, ownership included — without this the volumes arrive root-owned and
# `npm ci` dies with EACCES the moment it tries to write into them.
RUN mkdir -p /work/node_modules \
             /work/packages/core/node_modules \
             /work/packages/cli/node_modules \
             /work/packages/viewer/node_modules \
 && chown -R "$UID:$GID" /work

USER $UID:$GID

ENV NODE_OPTIONS=--max-old-space-size=4096
WORKDIR /work
CMD ["bash"]
