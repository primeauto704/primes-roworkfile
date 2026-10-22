'use strict';

/** An error the API turns into a JSON response: { error: code, message, ...extra }. */
class AppError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

module.exports = { AppError };
