FROM node:24-bookworm-slim AS node
FROM ubuntu:24.04
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /work
ENV BOXPILOT_DISPOSABLE_TEST=1
CMD ["node", "scripts/check-package-recovery-ubuntu.mjs"]
