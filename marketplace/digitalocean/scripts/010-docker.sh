#!/bin/bash
# Install Docker and the Compose v2 plugin (build-time, baked into the snapshot).
# Matches Pinchy's tested cloud-init deployment (Ubuntu's docker.io packages).
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get -qqy update
apt-get -qqy install docker.io docker-compose-v2
systemctl enable docker
systemctl start docker
