# -------------------------------------------------------------------------- #
#   Dockerfile — conteneur reproductible pour le serveur jak-ma-engine
# -------------------------------------------------------------------------- #
FROM node:18-slim

WORKDIR /app

# Dépendances de prod uniquement (sharp est en devDependencies).
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# Serveur Express ; configurer Mongo + clés providers via variables d'env.
CMD ["node", "server.js"]
