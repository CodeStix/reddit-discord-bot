FROM node:16.7

RUN apt install -y ffmpeg

ENV NODE_ENV="development"

WORKDIR /app
COPY . . 
RUN yarn build
RUN mkdir dist/cache dist/cache/ffmpeg dist/cache/videos

ENV NODE_ENV="production"

CMD ["node", "--max-old-space-size=4096", "dist/index.js"]