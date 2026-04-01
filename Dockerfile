FROM mcr.microsoft.com/playwright:v1.41.2-noble

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
