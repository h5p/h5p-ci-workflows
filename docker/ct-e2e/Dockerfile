# Shared CT E2E runtime: Playwright Chromium + pinned h5p-cli + h5p core.
# Rebuilds weekly.
FROM mcr.microsoft.com/playwright:v1.57.0-noble

USER root
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git git-lfs ca-certificates patch \
	&& rm -rf /var/lib/apt/lists/*

# Some content type dependencies build with webpack via "npm run build" and
# assume it is available on PATH; provide it globally so h5p setup succeeds.
RUN npm install -g webpack webpack-cli

ARG H5P_CLI_REF=bff73d9dbd9b7d4e1d3207e0297a68c5afb3e13d
WORKDIR /opt/h5p-cli
RUN git init \
	&& git remote add origin https://github.com/wwalmnes/h5p-cli.git \
	&& git fetch --depth 1 origin "${H5P_CLI_REF}" \
	&& git checkout FETCH_HEAD \
	&& npm ci --ignore-scripts \
	&& npm install -g . --ignore-scripts

WORKDIR /opt/h5p-runner
RUN h5p core
