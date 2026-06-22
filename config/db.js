// config/db.js
// Shared storage connection helper for the refactor.

module.exports = {
  getStorePath() {
    return new URL('../metadata', import.meta.url).pathname;
  },
};
