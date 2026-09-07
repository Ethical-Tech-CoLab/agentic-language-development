/**
 * The Gateway's test double for the Evidence Writer.
 *
 * The implementation lives in `src/testing.ts` so the Nursery Controller's
 * tests can reuse the exact same writer (exported as
 * `InMemoryEvidenceWriter` from `@ald/gateway`). It is re-exported here under
 * the `Fake…` name the Gateway tests read with.
 */
export {
  InMemoryEvidenceError as FakeEvidenceError,
  InMemoryEvidenceWriter as FakeEvidenceWriter,
  StepClock,
} from '../src/testing.js';
