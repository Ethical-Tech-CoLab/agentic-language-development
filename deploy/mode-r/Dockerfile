FROM node:24.20.0-alpine

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY contracts ./contracts
COPY packages ./packages
COPY twins ./twins
COPY deploy/mode-r ./deploy/mode-r

RUN corepack enable \
  && corepack prepare pnpm@12.3.4 --activate \
  && pnpm install --frozen-lockfile \
  && pnpm run build \
  && pnpm prune --prod

USER node

ENTRYPOINT ["/usr/bin/env", "-i", "/usr/local/bin/node", "--permission", "--allow-fs-read=/app", "/app/packages/isolation/bin/ald-learner-host.js"]
CMD ["--transport=tcp", "--bind=0.0.0.0", "--port=4318", "--track=no-learning"]
