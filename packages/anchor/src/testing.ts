/**
 * Test doubles other packages may import: the deterministic in-memory chain.
 *
 * Kept in its own entry point so a reader can see at a glance that nothing
 * here is production anchoring code.
 */
export {
  DEFAULT_FAKE_FROM_ADDRESS,
  FakeChainTransport,
  type FakeChainTransportOptions,
} from './fake-transport.js';
