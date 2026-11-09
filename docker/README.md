# Container

Build from the repository root with `docker build -f docker/Dockerfile -t miko-daemon .`.
The image installs the five Miko tarballs and exposes the execution/control endpoint on 7767.
State lives under `/data`; mount a private persistent volume there. The example Compose file
binds only the host loopback address.

Install any provider binaries and credentials you intend to use in your own derived image,
or configure an existing Paseo backend. The base image does not bundle authenticated agents.
Use `miko hub` and `miko backend` inside the container to configure the execution connection.
