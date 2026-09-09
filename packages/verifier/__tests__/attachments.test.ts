/** Analysis attachment hash, evidence-binding, and Experiment Record checks. */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BundleAttachmentIndexSchema,
  ExperimentRecordFileSchema,
  GENESIS_HASH,
  type BundleAttachmentIndex,
} from '@ald/types';

import { verifyBundle } from '../src/verify-bundle.js';
import { buildFixtureBundle, type BuiltBundle } from './fixtures/build-bundle.js';
import {
  copyBundle,
  mutateJsonFile,
  readJsonFile,
  writeJsonFile,
} from './helpers.js';

const OPTIONS = {
  verifierVersion: 'attachment-test-v1',
  now: () => new Date(Date.UTC(2026, 8, 1)).toISOString(),
};

describe('analysis attachments', () => {
  let fixture: BuiltBundle;

  beforeAll(async () => {
    fixture = await buildFixtureBundle({ attachment: true });
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it('verifies file bytes, the intervention binding, anchored coverage, and record link', async () => {
    const report = await verifyBundle(fixture.bundleDir, OPTIONS);
    const index = BundleAttachmentIndexSchema.parse(
      await readJsonFile<unknown>(join(fixture.bundleDir, 'analysis', 'index.json')),
    );
    const record = ExperimentRecordFileSchema.parse(
      await readJsonFile<unknown>(join(fixture.bundleDir, 'experiment-record.json')),
    );

    expect(report.exitCode).toBe(0);
    expect(report.gaps.filter((gap) => gap.startsWith('analysis-'))).toEqual([]);
    expect(index.attachments).toEqual([fixture.attachment]);
    expect(record.current['analysisAttachmentRefs']).toEqual([
      fixture.attachment?.sha256,
    ]);
  });

  it('rejects content tampering, a false binding, an unlisted file, and a missing record link', async () => {
    const contentCopy = await copyBundle(fixture.bundleDir);
    const bindingCopy = await copyBundle(fixture.bundleDir);
    const unlistedCopy = await copyBundle(fixture.bundleDir);
    const recordCopy = await copyBundle(fixture.bundleDir);
    try {
      await writeJsonFile(
        join(contentCopy.dir, 'analysis', 'red-team-observation', 'readiness.json'),
        { status: 'software-readiness', passed: false },
      );
      const contentReport = await verifyBundle(contentCopy.dir, OPTIONS);
      expect(contentReport.exitCode).toBe(1);
      expect(contentReport.gaps).toEqual(
        expect.arrayContaining([
          expect.stringContaining('analysis-attachment-hash-mismatch'),
        ]),
      );

      await mutateJsonFile<BundleAttachmentIndex>(
        join(bindingCopy.dir, 'analysis', 'index.json'),
        (index) => {
          const attachment = index.attachments[0];
          if (attachment?.boundBy !== undefined) {
            attachment.boundBy.entryHash = GENESIS_HASH;
          }
        },
      );
      const bindingReport = await verifyBundle(bindingCopy.dir, OPTIONS);
      expect(bindingReport.exitCode).toBe(1);
      expect(bindingReport.gaps).toEqual(
        expect.arrayContaining([
          expect.stringContaining('analysis-attachment-binding-invalid'),
        ]),
      );

      await mkdir(join(unlistedCopy.dir, 'analysis', 'other'), { recursive: true });
      await writeJsonFile(join(unlistedCopy.dir, 'analysis', 'other', 'extra.json'), {
        unlisted: true,
      });
      const unlistedReport = await verifyBundle(unlistedCopy.dir, OPTIONS);
      expect(unlistedReport.exitCode).toBe(1);
      expect(unlistedReport.gaps).toEqual(
        expect.arrayContaining([
          expect.stringContaining('analysis-attachment-unlisted'),
        ]),
      );

      await mutateJsonFile<Record<string, unknown>>(
        join(recordCopy.dir, 'experiment-record.json'),
        (file) => {
          const parsed = ExperimentRecordFileSchema.parse(file);
          delete parsed.current['analysisAttachmentRefs'];
          file['current'] = parsed.current;
        },
      );
      const recordReport = await verifyBundle(recordCopy.dir, OPTIONS);
      expect(recordReport.exitCode).toBe(1);
      expect(recordReport.gaps).toEqual(
        expect.arrayContaining([
          expect.stringContaining('experiment-record-attachment-missing'),
        ]),
      );
    } finally {
      await Promise.all([
        contentCopy.cleanup(),
        bindingCopy.cleanup(),
        unlistedCopy.cleanup(),
        recordCopy.cleanup(),
      ]);
    }
  });
});
