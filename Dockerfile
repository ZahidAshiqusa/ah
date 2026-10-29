FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./

RUN npm install --production --legacy-peer-deps --ignore-scripts && \
    npm rebuild sharp

COPY . .

RUN mkdir -p tmp session data /app/data/sessions /app/data/vault

ENV NODE_ENV=production
ENV PORT=3000
ENV RAILWAY_VOLUME_MOUNT_PATH=/app/data

EXPOSE 3000

CMD ["node", "server.js"]
