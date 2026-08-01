const OPTIONAL_SIGNING_VARIABLES = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID'
];

function sanitizedBuilderEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const name of OPTIONAL_SIGNING_VARIABLES) {
    const value = result[name];
    if (typeof value !== 'string' || value.trim() === '') delete result[name];
  }
  return result;
}

module.exports = { OPTIONAL_SIGNING_VARIABLES, sanitizedBuilderEnvironment };
