import { test, expect } from '@playwright/test';
import { mkdtemp, copyFile, symlink, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('blank settings and cache refresh preserve private API configuration', async ({ request }) => {
  // An isolated disposable server: never read or write a developer's real settings.
  const directory = await mkdtemp(path.join(tmpdir(), 'equity-config-test-'));
  let server;
  try {
    await copyFile('server.js', path.join(directory, 'server.js'));
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
    await symlink(path.resolve('node_modules'), path.join(directory, 'node_modules'));
    await mkdir(path.join(directory, 'data'));
    const config = { tossClientId: 'test-id', tossClientSecret: 'test-secret', fredApiKey: 'test-fred', secContactEmail: 'test@example.com' };
    const configFile = path.join(directory, 'data/config.json');
    await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    server = spawn(process.execPath, ['server.js'], {
      cwd: directory,
      env: { ...process.env, PORT: '3108', TOSS_CLIENT_ID: '', TOSS_CLIENT_SECRET: '', FRED_API_KEY: '', SEC_CONTACT_EMAIL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await Promise.race([
      once(server.stdout, 'data'),
      once(server, 'exit').then(() => { throw new Error('Isolated server exited before starting'); }),
    ]);
    const saved = await request.post('http://127.0.0.1:3108/api/config', {
      data: { tossClientId: '', tossClientSecret: ' ', fredApiKey: '', secContactEmail: '' },
    });
    expect(saved.status()).toBe(201);
    expect(JSON.parse(await readFile(configFile, 'utf8'))).toEqual(config);
    const refreshed = await request.post('http://127.0.0.1:3108/api/cache/refresh');
    expect(refreshed.ok()).toBe(true);
    expect(JSON.parse(await readFile(configFile, 'utf8'))).toEqual(config);
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
    const status = await request.get('http://127.0.0.1:3108/api/config');
    const body = await status.json();
    expect(body.configured.complete).toBe(true);
    expect(JSON.stringify(body)).not.toContain('test-secret');
  } finally {
    if (server && server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
