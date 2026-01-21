/**
 * Configuration for Playwright using default from @jupyterlab/galata
 */
const baseConfig = require('@jupyterlab/galata/lib/playwright-config');
const path = require('path');

const pythonCmd =
  process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const serverConfig = path.join(__dirname, 'jupyter_server_test_config.py');

module.exports = {
  ...baseConfig,
  timeout: 240 * 1000, // 4 minutes per test
  retries: process.env.CI ? 2 : 0,
  expect: {
    timeout: 30000 // 30 seconds for expects
  },
  use: {
    ...baseConfig.use,
    actionTimeout: 30000,
    // Capture trace on first retry (helps debug flaky tests)
    trace: 'on-first-retry',
    // Screenshot on failure for debugging
    screenshot: 'only-on-failure',
    // Video on first retry for debugging
    video: 'on-first-retry'
  },
  // Reporter configuration for better CI output
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  webServer: {
    command:
      'HOME=./.home ' +
      'IPYTHONDIR=./.jupyter/ipython ' +
      'JUPYTER_RUNTIME_DIR=./.jupyter/runtime ' +
      'JUPYTER_DATA_DIR=./.jupyter/data ' +
      'JUPYTER_CONFIG_DIR=./.jupyter/config ' +
      `S3_ACCESS_KEY="${process.env.S3_ACCESS_KEY || ''}" ` +
      `S3_SECRET_KEY="${process.env.S3_SECRET_KEY || ''}" ` +
      `S3_REGION="${process.env.S3_REGION || ''}" ` +
      `S3_ENDPOINT="${process.env.S3_ENDPOINT || ''}" ` +
      `${pythonCmd} -m jupyterlab --config "${serverConfig}"`,
    cwd: __dirname,
    url: 'http://localhost:8888/lab',
    timeout: 180 * 1000, // 3 minutes for server startup
    reuseExistingServer: !process.env.CI,
    // Capture server output for debugging
    stdout: 'pipe',
    stderr: 'pipe'
  }
};
