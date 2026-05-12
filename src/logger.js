import pino from 'pino';
import { config } from './config.js';

// Strict redaction: never let env contents land in logs.
export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: ['env', '*.env', 'process.env', '*.password', '*.token', '*.secret', '*.apiKey'],
    censor: '[redacted]',
  },
});
