'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createStaticFiles } = require('../src/panel/static-assets');

test('Static asset aliases, conditional requests and edits preserve response headers', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wolf-static-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const index = path.join(directory, 'index.html');
  await fs.writeFile(index, '<h1>First version</h1>');
  await fs.writeFile(path.join(directory, 'internal.txt'), 'private fixture');
  const serve = createStaticFiles(directory);

  async function request(route, ifNoneMatch) {
    const output = {};
    const response = {
      writeHead(status, headers) { Object.assign(output, { status, headers }); },
      end(body) { output.body = body?.toString(); },
    };
    await serve(response, route, { headers: { 'if-none-match': ifNoneMatch } }, (_, status) => {
      output.status = status;
    });
    return output;
  }

  const [first, alias] = await Promise.all([request('/'), request('/index.html')]);
  assert.equal(first.status, 200);
  assert.match(first.body, /First version/);
  assert.equal(first.headers.ETag, alias.headers.ETag);
  assert.equal(first.headers['Cache-Control'], 'no-cache');
  assert.match(first.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.equal(first.headers['X-Content-Type-Options'], 'nosniff');
  const cached = await request('/', first.headers.ETag);
  assert.equal(cached.status, 304);
  assert.equal(cached.body, undefined);

  await fs.writeFile(index, '<h1>Second version</h1>');
  const updated = await request('/', first.headers.ETag);
  assert.equal(updated.status, 200);
  assert.match(updated.body, /Second version/);
  assert.notEqual(updated.headers.ETag, first.headers.ETag);
  assert.equal((await request('/internal.txt')).status, 404);
  assert.equal((await request('/constructor')).status, 404);
  assert.equal((await request('/app.js')).status, 500);
});
