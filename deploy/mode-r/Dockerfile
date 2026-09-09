FROM node:24.13.0-alpine

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY contracts ./contracts
COPY packages ./packages
COPY twins ./twins
COPY deploy/mode-r ./deploy/mode-r

RUN npm ci \
  && npm run build \
  && npm prune --omit=dev

USER node

ENTRYPOINT ["/usr/bin/env", "-i", "/usr/local/bin/node", "--permission", "--allow-fs-read=/app", "/app/packages/isolation/bin/ald-learner-host.js"]
CMD ["--transport=tcp", "--bind=0.0.0.0", "--port=4318", "--track=no-learning"]
