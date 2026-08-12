FROM ubuntu:24.04

# Stable system packages. mise is installed here (a stable toolchain manager);
# the repository-pinned Node.js and pnpm versions are installed later from
# mise.toml during the idempotent `install` phase.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        git \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# Install mise system-wide so it is available regardless of the invoking user.
ENV MISE_VERSION=v2026.8.4
RUN curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh \
    && /usr/local/bin/mise --version

# The base image ships a non-root `ubuntu` user (uid 1000) used by the agent.
USER ubuntu
WORKDIR /home/ubuntu

# Put the mise binary and its tool shims on PATH for every process (login,
# non-login, and non-interactive shells), then activate mise for interactive
# bash sessions.
ENV PATH="/home/ubuntu/.local/share/mise/shims:/usr/local/bin:${PATH}"
RUN echo 'eval "$(mise activate bash)"' >> /home/ubuntu/.bashrc
