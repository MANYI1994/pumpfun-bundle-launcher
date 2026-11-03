import { emitKeypressEvents } from 'node:readline';
import { requireSafe, SafetyError } from './security.js';

export function hiddenInput(label, input = process.stdin, output = process.stderr) {
  requireSafe(input.isTTY && output.isTTY && typeof input.setRawMode === 'function', 'INTERACTIVE_TERMINAL_REQUIRED');
  return new Promise((resolve, reject) => {
    const previousRaw = input.isRaw;
    let value = '';
    emitKeypressEvents(input); output.write(label + ': '); input.setRawMode(true); input.resume();
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const cancel = () => { cleanup(); value = ''; reject(new SafetyError('CANCELLED')); };
    const cleanup = () => { input.off('keypress', onKey); signals.forEach(s => process.off(s, cancel)); input.setRawMode(Boolean(previousRaw)); input.pause(); output.write('\n'); };
    const onKey = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') { cleanup(); value = ''; reject(new SafetyError('CANCELLED')); }
      else if (key.name === 'return' || key.name === 'enter') { cleanup(); resolve(value); value = ''; }
      else if (key.name === 'backspace') value = value.slice(0, -1);
      else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text) && value.length + text.length <= 1024) value += text;
    };
    input.on('keypress', onKey);
    signals.forEach(s => process.once(s, cancel));
  });
}
