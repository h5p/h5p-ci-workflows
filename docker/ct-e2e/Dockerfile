# Shared CT E2E runtime: Playwright Chromium + pinned h5p-cli + h5p core.
# Rebuilds weekly.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

USER root
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# Some content type dependencies build with webpack via "npm run build" and
# assume it is available on PATH; provide it globally so h5p setup succeeds.
RUN npm install -g webpack webpack-cli

ARG H5P_CLI_REF=b33e87fd7d8a72eb641e008d8e9312042f947b02
WORKDIR /opt/h5p-cli
RUN git init \
	&& git remote add origin https://github.com/h5p/h5p-cli.git \
	&& git fetch --depth 1 origin "${H5P_CLI_REF}" \
	&& git checkout FETCH_HEAD \
	&& npm ci --ignore-scripts \
	&& npm install -g . --ignore-scripts

WORKDIR /opt/h5p-runner
RUN h5p core
