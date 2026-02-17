# Node.js + LibreDWG kurulu image
FROM node:20-slim

# LibreDWG kur (dwg2dxf için)
RUN apt-get update && apt-get install -y \
    libredwg-tools \
    && rm -rf /var/lib/apt/lists/*

# Uygulama klasörü
WORKDIR /app

# Bağımlılıkları kur
COPY package*.json ./
RUN npm install --production

# Kaynak kodu kopyala
COPY . .

# Port
EXPOSE 3000

# Başlat
CMD ["node", "server.js"]
