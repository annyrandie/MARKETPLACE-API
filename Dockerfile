# Single-stage, HW #5 style. No secrets baked in: the password comes from a
# file mounted at runtime (K8s Secret volume / Docker Swarm secret / a local
# `-v` mount), never from an ENV instruction or a build arg. .dockerignore
# keeps .env and secrets/ out of the build context entirely, so there is
# nothing here for `docker history` to leak even if it wanted to.
FROM node:22-slim
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN chown -R node:node /app
USER node

EXPOSE 3000
CMD ["node", "app.js"]
