const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizedBuilderEnvironment } = require('../scripts/build-environment');

test('removes empty optional signing variables before electron-builder starts', () => {
  const environment = sanitizedBuilderEnvironment({
    PATH: '/tools',
    CSC_LINK: '',
    CSC_KEY_PASSWORD: '   ',
    APPLE_ID: '',
    APPLE_APP_SPECIFIC_PASSWORD: '',
    APPLE_TEAM_ID: ''
  });

  assert.deepEqual(environment, { PATH: '/tools' });
});

test('preserves configured signing variables', () => {
  const environment = sanitizedBuilderEnvironment({
    CSC_LINK: 'base64-certificate',
    CSC_KEY_PASSWORD: 'secret',
    APPLE_ID: 'release@example.test',
    APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
    APPLE_TEAM_ID: 'TEAM123'
  });

  assert.equal(environment.CSC_LINK, 'base64-certificate');
  assert.equal(environment.CSC_KEY_PASSWORD, 'secret');
  assert.equal(environment.APPLE_ID, 'release@example.test');
  assert.equal(environment.APPLE_APP_SPECIFIC_PASSWORD, 'app-password');
  assert.equal(environment.APPLE_TEAM_ID, 'TEAM123');
});
