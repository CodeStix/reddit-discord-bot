#!/bin/bash

wget http://download.redis.io/releases/redis-6.0.4.tar.gz
tar xzf redis-6.0.4.tar.gz
cd redis-6.0.4
sudo make install