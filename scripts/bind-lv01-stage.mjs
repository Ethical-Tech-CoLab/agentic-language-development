#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { bindLv01StagePacket, verifyLv01StagePacket } from '@ald/orchestrator';

const stages = new Set(['development', 'qualification', 'pilot', 'confirmatory', 'replication']);
const { values } = parseArgs({
  options: { stage: { type: 'string' }, version: { type: 'string' }, write: { type: 'boolean', default: false } },
});
assert.ok(values.stage && stages.has(values.stage), 'stage must be supported, never arbitrary');
assert.match(values.version ?? '', /^[1-9]\d*$/u, 'version must be a positive integer');
assert.equal(values.write, true, 'bind writes only with --write');
const stage = values.stage;
const version = Number(values.version);

const registration = `protocols/lv01-${stage}-registration.v${version}.json`;
const bindingPath = `protocols/lv01-${stage}-registration-binding.v${version}.json`;
assert.equal(existsSync(registration), true, `missing prospective registration ${registration}`);
assert.equal(existsSync(bindingPath), false, `binding is immutable; ${bindingPath} already exists`);
const packet = verifyLv01StagePacket(JSON.parse(readFileSync(registration, 'utf8')));

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'bind requires a clean tracked tree');
const head = git('rev-parse', 'HEAD');
const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', packet.sourceCommit, head]).status === 0;
assert.equal(ancestor, true, 'binding source must descend from the registration source commit');

const allocationSha256 = `sha256:${createHash('sha256').update(readFileSync(packet.allocation.path)).digest('hex')}`;
assert.equal(allocationSha256, packet.allocation.sha256, 'allocation changed since registration');

const binding = bindLv01StagePacket(packet, head, allocationSha256);
writeFileSync(bindingPath, `${JSON.stringify(binding, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(`LV01 ${stage} v${version} bound: ${binding.bindingCommitment}`);
