import { requireSafe } from './security.js';

export const NETWORK_PROFILES = Object.freeze({
  devnet: Object.freeze({
    name: 'devnet',
    rpcUrl: 'https://api.devnet.solana.com/',
    genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    executionEnabled: true,
    journalNamespace: 'devnet',
  }),
  testnet: Object.freeze({
    name: 'testnet',
    rpcUrl: 'https://api.testnet.solana.com/',
    genesis: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
    executionEnabled: false,
    journalNamespace: 'jito-testnet',
  }),
  mainnet: Object.freeze({
    name: 'mainnet',
    rpcUrl: 'https://api.mainnet-beta.solana.com/',
    genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    executionEnabled: false,
    journalNamespace: 'mainnet',
  }),
});

export function networkProfile(name) {
  requireSafe(typeof name === 'string' && Object.hasOwn(NETWORK_PROFILES, name), 'UNKNOWN_NETWORK_PROFILE');
  return NETWORK_PROFILES[name];
}
