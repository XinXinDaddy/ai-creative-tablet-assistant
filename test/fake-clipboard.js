const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');

const spawn = childProcess.spawn;
let sequence = 0;

childProcess.spawn = (command, ...args) => {
  if (command !== 'powershell.exe') return spawn(command, ...args);

  const bridge = new EventEmitter();
  bridge.stdout = new PassThrough();
  bridge.stderr = new PassThrough();
  const reply = message => bridge.stdout.write(JSON.stringify(message) + '\n');
  bridge.stdin = new Writable({
    write(chunk, encoding, callback) {
      try {
        const request = JSON.parse(chunk.toString());
        if (request.cmd === 'SET_IMAGE') {
          fs.copyFileSync(request.filePath, path.join(process.cwd(), 'mock-clipboard.png'));
        }
        reply({ id: request.id, ok: true, hasImage: false, seq: ++sequence });
        callback();
      } catch (error) {
        callback(error);
      }
    }
  });
  queueMicrotask(() => reply({ status: 'READY' }));
  return bridge;
};
