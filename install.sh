#!/bin/bash

# exit on error
set -e

# setup filesystem
mkdir src/cache src/cache/ffmpeg src/cache/videos
cp redis.conf.example redis.conf
cp .env.example .env

# install youtube-dl and ffmpeg
apt install -y youtube-dl
apt install -y ffmpeg

# installing redis
apt install -y build-essential
wget http://download.redis.io/releases/redis-6.0.4.tar.gz
tar xzf redis-6.0.4.tar.gz
cd redis-6.0.4
make install
cd ..
rm redis-6.0.4.tar.gz
rm -rf redis-6.0.4

echo
echo ---- Installation complete ----
echo youtube-dl, ffmpeg and redis are successfully installed!
echo IMPORTANT: You must edit the .env and redis.conf files 
echo and provide them with the neccesary information.
echo You can register a discord bot token on the 
echo discord developer portal.