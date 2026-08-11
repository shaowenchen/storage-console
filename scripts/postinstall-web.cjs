const { existsSync } = require('fs');
const { execSync } = require('child_process');
const { join } = require('path');

if (process.env.SKIP_WEB_POSTINSTALL) {
  process.exit(0);
}

const webPackageJson = join(__dirname, '..', 'web', 'package.json');
if (!existsSync(webPackageJson)) {
  process.exit(0);
}

execSync('npm --prefix web install --include=dev --no-fund --no-audit', {
  stdio: 'inherit',
  cwd: join(__dirname, '..'),
});
