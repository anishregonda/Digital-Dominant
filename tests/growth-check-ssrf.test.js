// SSRF guard tests: the Growth Check must never be usable to reach private,
// internal or metadata addresses, directly, through DNS, or through a redirect.
// Offline except one optional real-DNS case (skipped when DNS is unavailable).
//   node tests/growth-check-ssrf.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import {
  GuardError,
  isPublicAddress,
  nodeTransport,
  normalizeUrl,
  pinnedLookup,
  resolveSafeAddresses,
  safeFetch,
} from '../api/_lib/net-guard.js';
import { runGrowthCheck } from '../api/_lib/growth-check-core.js';

const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
const TEST_PORT = 4317; // the local server for the real-transport cases (ports 4301-4320 only)

function refuses(input, code) {
  const result = normalizeUrl(input);
  assert.equal(result.ok, false, `${input} should be refused`);
  assert.equal(result.code, code, `${input}: expected ${code}, got ${result.code}`);
  assert.ok(result.message && !/[<>]/.test(result.message), 'refusals come with plain words');
}

test('refuses the addresses the brief names', async () => {
  refuses('http://localhost', 'private');
  refuses('http://localhost:3000/admin', 'bad_port');
  refuses('localhost', 'private');
  refuses('http://127.0.0.1', 'private');
  refuses('http://127.0.0.1:80/', 'private');
  refuses('http://10.0.0.1/', 'private');
  refuses('http://10.200.3.4/x', 'private');
  refuses('http://192.168.1.1/', 'private');
  refuses('192.168.0.10', 'private');
  refuses('http://169.254.169.254/latest/meta-data/', 'private');
  refuses('http://[::1]/', 'private');
  refuses('file:///etc/passwd', 'bad_scheme');
  refuses('ftp://example.com/', 'bad_scheme');
  refuses('http://example.com:8080/', 'bad_port');
  refuses('example.com:8080', 'bad_port');
  // ...and each one fails the whole run the same way, without any request.
  for (const url of ['http://localhost', 'http://127.0.0.1', 'http://10.1.2.3', 'http://192.168.1.1', 'http://169.254.169.254', 'http://[::1]', 'file:///etc/passwd', 'ftp://example.com', 'http://example.com:8080']) {
    const report = await runGrowthCheck({ url }, { deps: { transport: () => assert.fail(`no request for ${url}`) } });
    assert.equal(report.ok, false, url);
  }
});

test('refuses other private, reserved and disguised forms', () => {
  for (const input of [
    'http://0.0.0.0/',
    'http://0/',
    'http://127.1/',
    'http://2130706433/', // decimal 127.0.0.1
    'http://0x7f.0.0.1/', // hex
    'http://0177.0.0.1/', // octal
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://100.64.0.1/', // carrier-grade NAT
    'http://100.100.100.200/', // Alibaba Cloud metadata
    'http://192.0.0.192/', // Oracle Cloud metadata
    'http://198.18.0.1/',
    'http://224.0.0.1/',
    'http://255.255.255.255/',
    'http://[::]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::127.0.0.1]/',
    'http://[fd00:ec2::254]/', // AWS IPv6 metadata
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'http://[ff02::1]/',
    'http://[64:ff9b::a00:1]/', // NAT64 of 10.0.0.1
    'http://[2002:7f00:1::]/', // 6to4 of 127.0.0.1
    'http://[2001:db8::1]/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://foo.localhost/',
    'http://printer.local/',
    'http://router.lan/',
  ]) {
    refuses(input, 'private');
  }
  refuses('https://user:secret@example.com/', 'credentials');
  refuses('javascript:alert(1)', 'bad_scheme');
  refuses('data:text/html,<h1>hi</h1>', 'bad_scheme');
  refuses('gopher://example.com/', 'bad_scheme');
  refuses('http://intranet/', 'private');
  refuses('http://myserver/', 'invalid_url');
  refuses('', 'missing_url');
  refuses('   ', 'missing_url');
  refuses(`https://example.com/${'a'.repeat(2100)}`, 'too_long');
  refuses('https://exa mple.com/', 'invalid_url');
});

test('accepts normal public websites and tidies them up', () => {
  const cases = [
    ['tuskertees.com', 'https://tuskertees.com/'],
    ['  www.Example.com/about?x=1#team ', 'https://www.example.com/about?x=1'],
    ['HTTP://Example.COM', 'http://example.com/'],
    ['//example.com/', 'https://example.com/'],
    ['https://example.com:443/', 'https://example.com/'],
    ['http://example.com:80/', 'http://example.com/'],
    ['http://example.com:443/', 'http://example.com:443/'],
    ['http://8.8.8.8/', 'http://8.8.8.8/'],
    ['https://[2606:4700:4700::1111]/', 'https://[2606:4700:4700::1111]/'],
    ['bücher.example', 'https://xn--bcher-kva.example/'],
  ];
  for (const [input, href] of cases) {
    const result = normalizeUrl(input);
    assert.equal(result.ok, true, `${input}: ${result.message}`);
    assert.equal(result.url.href, href);
  }
  assert.equal(normalizeUrl('tuskertees.com').schemeAdded, true);
  assert.equal(normalizeUrl('https://tuskertees.com').schemeAdded, false);
});

test('isPublicAddress: the address table', () => {
  const blocked = [
    '127.0.0.1', '10.0.0.1', '172.16.5.5', '192.168.0.1', '169.254.169.254', '100.64.1.1', '0.0.0.0',
    '224.0.0.251', '240.0.0.1', '255.255.255.255', '192.0.2.1', '198.51.100.7', '203.0.113.9',
    '::', '::1', '::ffff:10.0.0.1', '::ffff:a00:1', 'fe80::1%eth0', 'fd12:3456::1', 'ff02::1', '2001::1', '2001:db8::5',
    'not-an-ip', '', '1.2.3', '999.1.1.1',
  ];
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1',
    '2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8', '64:ff9b::808:808'];
  for (const ip of blocked) assert.equal(isPublicAddress(ip), false, `${ip} must be refused`);
  for (const ip of allowed) assert.equal(isPublicAddress(ip), true, `${ip} is public`);
});

test('a hostname that resolves to a private address is refused (and so is a mixed answer)', async () => {
  const fake = (answers) => async (host) => {
    if (!(host in answers)) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    return answers[host];
  };
  const resolve = fake({
    'evil.example': [{ address: '10.0.0.5', family: 4 }],
    'sneaky.example': [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
    'metadata.example': [{ address: '169.254.169.254', family: 4 }],
    'v6.example': [{ address: '::1', family: 6 }],
    'mapped.example': [{ address: '::ffff:192.168.1.1', family: 6 }],
    'empty.example': [],
    'fine.example': PUBLIC,
  });
  for (const host of ['evil.example', 'sneaky.example', 'metadata.example', 'v6.example', 'mapped.example']) {
    await assert.rejects(resolveSafeAddresses(new URL(`http://${host}/`), { resolve }), (e) => e instanceof GuardError && e.code === 'private', host);
    const report = await runGrowthCheck({ url: host }, { deps: { resolve, transport: () => assert.fail('must not connect') } });
    assert.deepEqual([report.ok, report.code], [false, 'private'], host);
  }
  await assert.rejects(resolveSafeAddresses(new URL('http://empty.example/'), { resolve }), (e) => e.code === 'dns');
  await assert.rejects(resolveSafeAddresses(new URL('http://missing.example/'), { resolve }), (e) => e.code === 'dns');
  assert.deepEqual(await resolveSafeAddresses(new URL('http://fine.example/'), { resolve }), PUBLIC);
});

test('real DNS: a public name that points at a private address is refused', async (t) => {
  // Public wildcard-DNS names that answer with private addresses. Some resolvers
  // drop loopback answers, so use the first one that resolves here.
  const candidates = ['localtest.me', '127.0.0.1.nip.io', '10.0.0.1.nip.io', '192.168.1.1.nip.io', '10.0.0.1.sslip.io'];
  let host = null;
  for (const name of candidates) {
    try {
      const answer = await dns.promises.lookup(name, { all: true });
      if (answer.length && answer.every((a) => !isPublicAddress(a.address))) {
        host = name;
        break;
      }
    } catch {
      /* try the next one */
    }
  }
  if (!host) {
    t.skip('no private-answer test name resolves here; the faked-DNS test above covers this');
    return;
  }
  await assert.rejects(resolveSafeAddresses(new URL(`http://${host}/`)), (e) => e.code === 'private', host);
  const report = await runGrowthCheck({ url: host });
  assert.deepEqual([report.ok, report.code], [false, 'private'], host);
});

test('redirects are re-checked: private targets, bad ports, odd schemes, too many hops', async () => {
  const resolve = async (host) => {
    if (host === 'internal.example') return [{ address: '10.1.2.3', family: 4 }];
    return PUBLIC;
  };
  const makeTransport = (locations) => {
    const seen = [];
    const transport = async (url) => {
      seen.push(url.href);
      const location = locations[url.href];
      if (location) return { status: 302, headers: { location }, body: Buffer.alloc(0), bytes: 0, truncated: false };
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<title>ok</title>'), bytes: 17, truncated: false };
    };
    return { transport, seen };
  };
  const cases = [
    ['http://169.254.169.254/latest/meta-data/iam/', 'private'],
    ['http://127.0.0.1/', 'private'],
    ['http://[::1]:80/', 'private'],
    ['http://internal.example/admin', 'private'],
    ['http://example.org:8080/', 'bad_port'],
    ['file:///etc/passwd', 'bad_redirect'],
    ['gopher://example.org/', 'bad_redirect'],
  ];
  for (const [target, code] of cases) {
    const { transport, seen } = makeTransport({ 'https://redirector.example/': target });
    await assert.rejects(
      safeFetch(new URL('https://redirector.example/'), { resolve, transport }),
      (e) => e instanceof GuardError && e.code === code,
      `redirect to ${target}`,
    );
    assert.deepEqual(seen, ['https://redirector.example/'], `never connected to ${target}`);
    const report = await runGrowthCheck({ url: 'https://redirector.example/' }, { deps: { resolve, transport } });
    assert.deepEqual([report.ok, report.code], [false, code], `whole run, redirect to ${target}`);
  }

  // A relative redirect into a private address (via the Host it names) is refused too.
  {
    const { transport } = makeTransport({ 'https://redirector.example/': '//internal.example/' });
    await assert.rejects(safeFetch(new URL('https://redirector.example/'), { resolve, transport }), (e) => e.code === 'private');
  }

  // Four redirects are fine; the fifth is refused.
  const chain = {};
  for (let i = 0; i < 5; i++) chain[`https://hop${i}.example/`] = `https://hop${i + 1}.example/`;
  {
    const { transport } = makeTransport(chain);
    const ok = await safeFetch(new URL('https://hop1.example/'), { resolve, transport });
    assert.equal(ok.url.href, 'https://hop5.example/');
    assert.equal(ok.redirects.length, 4);
  }
  {
    const { transport, seen } = makeTransport(chain);
    await assert.rejects(safeFetch(new URL('https://hop0.example/'), { resolve, transport }), (e) => e.code === 'too_many_redirects');
    assert.equal(seen.length, 5);
  }
  // A loop runs into the same limit.
  {
    const { transport } = makeTransport({ 'https://a.example/': 'https://b.example/', 'https://b.example/': 'https://a.example/' });
    await assert.rejects(safeFetch(new URL('https://a.example/'), { resolve, transport }), (e) => e.code === 'too_many_redirects');
  }
});

test('image requests go through the same guard', async () => {
  const { measureImages } = await import('../api/_lib/growth-check-core.js');
  const asked = [];
  const transport = async (url, opts) => {
    asked.push(url.href);
    return { status: 200, headers: { 'content-length': '1000' }, body: Buffer.alloc(0), bytes: 0, truncated: false, opts };
  };
  const resolve = async (host) => (host === 'cdn.example' ? PUBLIC : [{ address: '192.168.0.9', family: 4 }]);
  const result = await measureImages(
    [
      { url: 'https://cdn.example/ok.jpg' },
      { url: 'http://169.254.169.254/latest/meta-data/' },
      { url: 'http://nas.example/photo.jpg' },
      { url: 'http://cdn.example:8080/odd.jpg' },
    ],
    { deps: { resolve, transport } },
  );
  assert.deepEqual(asked, ['https://cdn.example/ok.jpg']);
  assert.equal(result.measured, 1);
});

// ---- Real sockets: the connection itself is pinned to the checked addresses ----
function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(TEST_PORT, '127.0.0.1', () => resolve(server));
  });
}

test('real transport: connects only to the pinned, checked address', async () => {
  const hits = [];
  const server = await startServer((req, res) => {
    hits.push(`${req.headers.host} ${req.url}`);
    if (req.url === '/go-private') {
      res.writeHead(302, { location: 'http://10.255.255.1/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>pinned</title>');
  });
  try {
    // "pinned.test" doesn't exist in DNS; the pinned lookup hands the socket
    // 127.0.0.1 because this test says that address was checked.
    const allowLoopbackForTest = (ip) => ip === '127.0.0.1' || isPublicAddress(ip);
    const url = new URL(`http://pinned.test:${TEST_PORT}/hello`);
    const ok = await nodeTransport(url, {
      addresses: [{ address: '127.0.0.1', family: 4 }],
      isAllowed: allowLoopbackForTest,
      timeoutMs: 3000,
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.toString(), '<title>pinned</title>');

    // With the real rule, the same pinned loopback address is refused at connect time.
    await assert.rejects(
      nodeTransport(url, { addresses: [{ address: '127.0.0.1', family: 4 }], timeoutMs: 3000 }),
      (e) => e.code === 'ENOTFOUND',
    );

    // A real redirect to a private address: the first hop is let through for
    // the test, the second hop is refused before any connection is made.
    const viaRealRedirect = safeFetch(new URL('http://redirect.test/go-private'), {
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      isAllowed: allowLoopbackForTest,
      transport: (u, opts) => nodeTransport(new URL(`http://${u.hostname}:${TEST_PORT}${u.pathname}`), opts),
      timeoutMs: 3000,
    });
    await assert.rejects(viaRealRedirect, (e) => e instanceof GuardError && e.code === 'private');
    assert.deepEqual(hits, [`pinned.test:${TEST_PORT} /hello`, `redirect.test:${TEST_PORT} /go-private`]);
  } finally {
    server.close();
  }
});

test('pinnedLookup answers only with checked addresses, in both callback styles', async () => {
  const lookup = pinnedLookup([
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.1', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ]);
  const all = await new Promise((resolve, reject) => lookup('x.example', { all: true }, (e, list) => (e ? reject(e) : resolve(list))));
  assert.deepEqual(all.map((a) => a.address), ['93.184.216.34', '2606:4700:4700::1111']);
  const v6 = await new Promise((resolve, reject) => lookup('x.example', { family: 6 }, (e, a, f) => (e ? reject(e) : resolve([a, f]))));
  assert.deepEqual(v6, ['2606:4700:4700::1111', 6]);
  const none = await new Promise((resolve) => pinnedLookup([{ address: '127.0.0.1', family: 4 }])('x', {}, (e) => resolve(e)));
  assert.equal(none.code, 'ENOTFOUND');
});

test('the response body is capped (after decompression)', async () => {
  const zlib = await import('node:zlib');
  const big = zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024, 'a')); // ~5 KB gzip, 5 MB unpacked
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.end(big);
  });
  try {
    const res = await nodeTransport(new URL(`http://bomb.test:${TEST_PORT}/`), {
      addresses: [{ address: '127.0.0.1', family: 4 }],
      isAllowed: (ip) => ip === '127.0.0.1',
      maxBytes: 64 * 1024,
      timeoutMs: 3000,
    });
    assert.equal(res.truncated, true);
    assert.equal(res.body.length, 64 * 1024);
  } finally {
    server.close();
  }
});
