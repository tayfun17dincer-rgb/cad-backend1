FROM node:20-bookworm-slim

# Derleme araçları + LibreDWG kur
RUN apt-get update && apt-get install -y \
    build-essential \
    autoconf \
    automake \
    libtool \
    pkg-config \
    wget \
    python3 \
    swig \
    && wget -q https://ftp.gnu.org/gnu/libredwg/libredwg-0.12.5.tar.gz \
    && tar -xzf libredwg-0.12.5.tar.gz \
    && cd libredwg-0.12.5 \
    && ./configure --disable-bindings --disable-python \
    && make -j$(nproc) \
    && make install \
    && ldconfig \
    && cd .. \
    && rm -rf libredwg-0.12.5* \
    && apt-get remove -y build-essential autoconf automake libtool wget \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
