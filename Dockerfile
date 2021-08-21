FROM node:16.7

RUN apt update && apt install -y ffmpeg python
RUN curl -L https://github.com/ytdl-org/youtube-dl/releases/latest/download/youtube-dl -o /usr/local/bin/youtube-dl
RUN chmod +x /usr/local/bin/youtube-dl

ENV NODE_ENV="development"

WORKDIR /app
COPY . . 
RUN yarn
RUN yarn build
RUN mkdir dist/cache dist/cache/ffmpeg dist/cache/videos

ENV NODE_ENV="production"

CMD ["node", "--max-old-space-size=4096", "dist/index.js"]