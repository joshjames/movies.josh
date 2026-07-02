// src/config/square.js
const { SquareClient, SquareEnvironment } = require('square');

// Determine execution environment mode
const isProduction = process.env.NODE_ENV === 'production';

function firstDefined(...values) {
  for (const value of values) {
    const clean = String(value || '').trim();
    if (clean) return clean;
  }
  return null;
}

// Safely map the right tokens based on the environment state matrix
const accessToken = isProduction 
  ? firstDefined(process.env.SQUARE_PROD_ACCESS_TOKEN)
  : firstDefined(process.env.SQUARE_SANDBOX_ACCESS_TOKEN);

const applicationId = isProduction
  ? firstDefined(process.env.SQUARE_PROD_APPLICATION_ID, process.env.SQUAREPAY_PRODUCTION)
  : firstDefined(process.env.SQUARE_SANDBOX_APPLICATION_ID, process.env.SQUAREPAY_SANDBOX);

const locationId = isProduction
  ? firstDefined(process.env.SQUARE_PROD_LOCATION_ID, process.env.SQUARE_LOCATION_ID)
  : firstDefined(process.env.SQUARE_LOCATION_ID, process.env.SQUARE_SANDBOX_LOCATION_ID);

const environment = isProduction 
  ? SquareEnvironment.Production 
  : SquareEnvironment.Sandbox;

if (!accessToken) {
  console.error(`🚨 CRITICAL: Square Access Token missing for NODE_ENV=${process.env.NODE_ENV}`);
}

// Instantiate a single unified instance client
const squareInstance = new SquareClient({
  token: accessToken,
  environment: environment,
});

// Export both the unified client and your raw ID keys for reference down the pipeline
module.exports = {
  square: squareInstance,
  config: {
    applicationId,
    locationId,
    isProduction
  }
};