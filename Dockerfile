FROM node:22-alpine
# MD1: ffmpeg يحوّل الرسايل الصوتية (ogg/opus) لـmp3 للآيفونات اللي مابتشغّلهاش — من غيره المسار بيرجّع 501 والشاشة تعرض تحميل
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "index.js"]
