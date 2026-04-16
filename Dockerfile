FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p data && chmod 777 data
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]
