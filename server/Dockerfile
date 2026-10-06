FROM node:24-alpine

WORKDIR /app

# Install the single runtime dependency first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev

# Copy the application
COPY . .

ENV PORT=3001 \
    DB_PATH=/app/data/obulu.db

RUN mkdir -p /app/data

EXPOSE 3001

CMD ["node", "src/index.js"]
