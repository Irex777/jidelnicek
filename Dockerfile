FROM node:18-slim
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p data && chmod 777 data
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]
