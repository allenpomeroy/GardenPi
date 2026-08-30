// GardenPi Control v2.0.0 — server/logger.js
// Centralized logging. Writes readable console logs plus rotating files under LOG_DIR:
//   app-YYYY-MM-DD.log    - all activity (info and above)
//   error-YYYY-MM-DD.log  - errors only, for fast troubleshooting
const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');
const config = require('./config').load();

const LOG_DIR = config.server.logDir;
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const fmt = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}`;
  })
);

const logger = winston.createLogger({
  level: config.server.logLevel,
  format: fmt,
  transports: [
    new winston.transports.Console(),
    new winston.transports.DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d'
    }),
    new winston.transports.DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxFiles: '90d'
    })
  ]
});

module.exports = logger;
