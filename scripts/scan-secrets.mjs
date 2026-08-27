import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8' },
)
  .split(/\r?\n/u)
  .filter(Boolean);

const privateKeyMarker = ['-----BEGIN ', '(?:RSA |EC |OPENSSH )?PRIVATE KEY-----'].join('');
const patterns = [
  { name: 'private key', pattern: new RegExp(privateKeyMarker, 'u') },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/u },
  { name: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u },
  {
    name: 'assigned secret',
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*["'][^"'\r\n]{12,}["']/iu,
  },
];

const findings = [];

for (const file of files) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  for (const { name, pattern } of patterns) {
    if (pattern.test(content)) {
      findings.push(`${file}: ${name}`);
    }
  }
}

if (findings.length > 0) {
  console.error('Potential committed secrets detected:');
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed for ${files.length} files.`);
}
