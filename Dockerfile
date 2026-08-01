FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
