// GardenPi Control v2.0.0 — server/middleware/errorHandler.js
const logger = require('../logger');

// Ensures the client NEVER sees a raw stack trace or a generic "500 Internal Server
// Error" page -- every response is small, friendly JSON. Full detail always goes to
// the server logs for troubleshooting.
module.exports = function errorHandler(err, req, res, next) {
  let status = 500;
  let message = 'Something went wrong on our end. Please try again in a moment.';

  if (err.code === 'GARDENAPI_UNREACHABLE') {
    status = 200; // handled condition, not a hard failure of this web app
    // gardenApiClient already produced a specific, friendly message (auth
    // rejected, handler unavailable, controller unreachable, etc) -- use it
    // rather than flattening every controller problem into one generic line.
    message = err.message || 'The irrigation controller is not responding right now. Please check the device and try again.';
  } else if (err.code === 'VALVE_CONFLICT') {
    status = 409;
    message = err.message;
  } else if (err.status === 400 || err.code === 'BAD_INPUT') {
    status = 200;
    message = err.message || 'Please check your input and try again.';
  }

  // Expected/handled conditions (guard-rail conflicts, unreachable hardware, bad input)
  // are logged at "warn" so error-level logs stay meaningful for real bugs.
  const level = (err.code === 'VALVE_CONFLICT' || err.code === 'GARDENAPI_UNREACHABLE' || err.code === 'BAD_INPUT') ? 'warn' : 'error';
  logger[level]('Request could not be completed', {
    path: req.path,
    method: req.method,
    message: err.message,
    cause: err.cause,
    stack: level === 'error' ? err.stack : undefined
  });

  res.status(status).json({ ok: false, message });
};
