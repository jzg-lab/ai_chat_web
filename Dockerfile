FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY chat-web/package.json chat-web/package.json
COPY chat-server/package.json chat-server/package.json
RUN npm install

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY package.json package-lock.json* ./
COPY chat-server/package.json chat-server/package.json
RUN npm install --omit=dev --workspace chat-server
COPY chat-server ./chat-server
COPY --from=build /app/chat-web/dist ./chat-web/dist
EXPOSE 3000
CMD ["npm", "run", "start", "--workspace", "chat-server"]
