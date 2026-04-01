FROM mcr.microsoft.com/playwright:v1.41.2-jammy

WORKDIR /app

COPY . .

ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
