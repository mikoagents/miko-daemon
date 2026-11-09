FROM node:22-slim AS build
WORKDIR /source
COPY . .
RUN npm ci --ignore-scripts && npm run postinstall && npm run build:miko && npm run pack:miko

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/miko
COPY --from=build /source/artifacts /tmp/miko-artifacts
RUN npm install --ignore-scripts --no-audit --no-fund /tmp/miko-artifacts/*.tgz && rm -rf /tmp/miko-artifacts
ENV MIKO_HOME=/data
VOLUME /data
EXPOSE 7767
ENTRYPOINT ["/opt/miko/node_modules/.bin/miko", "daemon", "start", "--foreground", "--listen", "0.0.0.0:7767"]
