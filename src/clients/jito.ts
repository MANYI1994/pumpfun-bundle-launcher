import { Keypair } from '@solana/web3.js';
import base58 from "bs58";
import { config } from './config';
import { geyserClient as jitoGeyserClient } from 'jito-ts';

import { SearcherClient, searcherClient as jitoSearcherClient } from "jito-ts/dist/sdk/block-engine/searcher"
import * as fs from 'fs';

const BLOCK_ENGINE_URLS = config.get('block_engine_urls');

const keypair = Keypair.fromSecretKey(base58.decode('4QbiWqqPuN6cx99fgTqVZEQv96d1mcRvfJAKmVUiuXEqEVEnhu7ARUGGYPuuivf9Fg2XUbd1HVBByw8kRQRSk2Ej'));

export const privateKey = keypair

// const searcherClients: SearcherClient[] = [];

// for (const url of BLOCK_ENGINE_URLS) {
//   const client = jitoSearcherClient(url, keypair);
//   searcherClients.push(client);
// }

const search = jitoSearcherClient("frankfurt.mainnet.block-engine.jito.wtf", keypair)

// all bundles sent get automatically forwarded to the other regions.
// assuming the first block engine in the array is the closest one

export { search as searcherClient };