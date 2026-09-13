import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectE02Observations } from './collect-e02-observations.mjs';
import { validateE02SlotContract } from './e02-slot-contract.mjs';

const [slotText, seed, softwareCommit] = process.argv.slice(2);
assert.equal(process.argv.length, 5, 'usage: run-e02-slot.mjs <slot> <seed> <execution-commit>');
const slot = Number(slotText);
const packet = JSON.parse(await readFile('/evidence/registration-packet.json', 'utf8'));
const binding = JSON.parse(await readFile('/evidence/registration-binding.json', 'utf8'));
const registration = validateE02SlotContract(packet, binding, slot, seed, 'protocols/e02-registration.v3.json');
const result = await collectE02Observations({ directory: `/evidence/registered-e02-v3-${slot}`,
  seed, mode: 'research-grade', profile: 'registered', softwareCommit, registration, slot });
if (!result.passed) process.exitCode = 1;
