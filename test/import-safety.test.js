import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

test('loading every application module does not scan configuration files or open network connections', async () => {
  const touched = [], replacements = [];
  const patch = (object, key, replacement) => { const previous = object[key]; object[key] = replacement; replacements.push(() => { object[key] = previous; }); };
  const forbidden = kind => (..._args) => { touched.push(kind); throw new Error('Unexpected startup access'); };
  const read = fs.readFileSync;
  patch(fs, 'readFileSync', function(file, ...args) {
    if (typeof file === 'string' && /(?:^|\/)(?:config\.(?:ts|json|js)|\.env)$/.test(file)) return forbidden('configuration read')();
    return read.call(this, file, ...args);
  });
  patch(globalThis, 'fetch', forbidden('fetch'));
  for (const [object, names] of [[http, ['request', 'get']], [https, ['request', 'get']], [net, ['connect', 'createConnection']], [tls, ['connect']]]) for (const name of names) patch(object, name, forbidden(name));
  try {
    for (const module of ['security', 'vault', 'network', 'plans', 'transactions', 'settlement', 'terminal', 'cli']) await import('../src/' + module + '.js');
    assert.deepEqual(touched, []);
  } finally { replacements.reverse().forEach(restore => restore()); }
});
