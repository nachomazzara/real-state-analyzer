FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Install the official Claude Code CLI globally so the agent-based scrapers
# can spawn `claude` subprocesses. Auth comes from the volume-mounted
# ~/.claude (configured in docker-compose.yml) or, if set, a
# CLAUDE_CODE_OAUTH_TOKEN env var.
RUN npm install -g @anthropic-ai/claude-code@latest

COPY package*.json ./
RUN npm install --omit=dev

COPY . .
RUN chmod +x docker/entrypoint.sh \
 && mkdir -p /app/data \
 && chown -R pwuser:pwuser /app

# Drop privileges. Claude CLI refuses to run with --dangerously-skip-permissions
# as root, and we don't need root for anything else.
USER pwuser

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=10 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

ENTRYPOINT ["docker/entrypoint.sh"]
CMD ["node", "src/server.js"]
