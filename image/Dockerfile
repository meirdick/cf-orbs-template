# cf-orbs orb image. Built by `cf-orbs deploy` (wrangler) and stored under the image key "orb".
#
# Why a digest pin and not :latest
#   A snapshot only restores onto the image it was taken from. A moving tag gives a new image on the
#   next deploy, and paused orbs and project snapshots stop restoring. Cloudflare also rejects GAR refs
#   in config, so we build FROM the digest. Bump the digest only with `cf-orbs upgrade`: it keeps the
#   old image key while snapshots still use it.
#
# Why tini
#   The base image has no init and its CMD (python3) exits at once. tini is PID 1, keeps the container
#   up with `sleep infinity`, and reaps the processes that cf-orbs starts with setsid (amp orb bootstrap
#   and its children). -s makes tini a subreaper, so orphans of those processes are reaped too.
#   tini is pinned to one Debian version so that a rebuild without cache gives the same layer.
#   If apt cannot find that version any more, bump it and treat the result as a new image.
#
# How to add toolchains
#   Add RUN lines between "USER root" and "USER user" below. Example:
#     RUN apt-get update && apt-get install -y --no-install-recommends golang-go \
#      && rm -rf /var/lib/apt/lists/*
#   Pin versions where you can. Keep user `user` (uid 1000), HOME /home/user, sudo, and the
#   ENTRYPOINT/CMD lines: cf-orbs needs them. Then run `cf-orbs deploy`. See image/README.md.
FROM us-central1-docker.pkg.dev/amp-prod-0/amp-orb/amp-orb@sha256:378c5e2188f00960eca36dc806aa04e1cacd92c2341665bcdf4692326c462d6d

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini=0.19.0-1+b3 \
 && rm -rf /var/lib/apt/lists/*

# --- your toolchains go here ---

USER user
WORKDIR /home/user
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["sleep", "infinity"]
