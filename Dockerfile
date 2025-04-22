FROM node:22

WORKDIR /app

COPY package*.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
COPY params.txt ./
COPY params_full.txt ./

RUN mkdir -p /app/ca /app/certs && \
    chmod +x /app/scripts/*.sh && \
    /app/scripts/gen_ca.sh

RUN npm i

EXPOSE 8080 8000

CMD ["node", "src/proxy.js"]