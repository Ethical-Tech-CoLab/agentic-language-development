import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { verifyBundle, VERIFIER_VERSION } from '@ald/verifier';

import { required } from './application-common.mjs';

const outputRoot = required('ALD_MODE_R_OUTPUT_ROOT');
const parentBundleDir = process.env.ALD_MODE_R_PARENT_BUNDLE;
const report = await verifyBundle(join(outputRoot, 'bundle'), {
  verifierVersion: VERIFIER_VERSION,
  now: () => new Date().toISOString(),
  allowUnanchored: true,
  ...(parentBundleDir === undefined || parentBundleDir === '' ? {} : { parentBundleDir }),
});
await writeFile(join(outputRoot, 'offline-verification.json'),
  `${JSON.stringify(report, null, 2)}\n`);
if (report.exitCode !== 0) process.exitCode = report.exitCode;
