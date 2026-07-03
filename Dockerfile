FROM node:20-bookworm-slim

# Dependências de runtime do node-canvas (cairo/pango/jpeg/gif/rsvg/pixman)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 \
    libjpeg62-turbo libgif7 librsvg2-2 libpixman-1-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instala deps primeiro (cache de layer) — npm ci = build reproduzível a partir do lock
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copia o resto (server.js + assets/)
COPY . .

# Pasta pública onde os JPEGs renderizados são servidos
RUN mkdir -p public/img

ENV PORT=3002
EXPOSE 3002

CMD ["node", "server.js"]
