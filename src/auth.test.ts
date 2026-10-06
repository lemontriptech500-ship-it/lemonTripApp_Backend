import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { after, before, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { PGlite } from '@electric-sql/pglite';
import nock from 'nock';
import { app } from './app.js';
import { createAccessToken, hashOpaqueToken, hashPassword, verifyPassword } from './auth.js';
import { normalizePhone } from './authProviders.js';
import { env } from './config.js';
import { pool } from './db.js';
import { readFile } from 'node:fs/promises';

let server: ReturnType<typeof app.listen>;
let baseUrl = '';
let database: PGlite;
let verificationToken = '';
let sentOtp = '';
let originalFetch: typeof fetch;
const realPool = pool as unknown as { query: (...args: any[]) => unknown; connect: () => unknown };
let originalPoolQuery: (...args: any[]) => unknown;
let originalPoolConnect: () => unknown;
const googleKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const googleCertificate = googleKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function signedGoogleToken(subject: string, email: string) {
  return jwt.sign({
    sub: subject,
    email,
    email_verified: true,
    name: 'Google Traveler',
    given_name: 'Google',
    family_name: 'Traveler',
  }, googleKeys.privateKey, {
    algorithm: 'RS256',
    keyid: 'lemontrip-test-key',
    audience: 'test-google-client',
    issuer: 'https://accounts.google.com',
    expiresIn: '5m',
  });
}

before(async () => {
  database = new PGlite();
  await database.exec(`CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    email text NOT NULL UNIQUE,
    phone text,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  const migration = await readFile(new URL('../migrations/002_shared_auth.sql', import.meta.url), 'utf8');
  const userPlatformMigration = await readFile(new URL('../migrations/005_user_platform.sql', import.meta.url), 'utf8');
  await database.exec('BEGIN');
  await database.exec(migration);
  await database.exec('COMMIT');
  await database.exec(userPlatformMigration);
  await database.exec(`
    CREATE TABLE blog_posts (
      id varchar PRIMARY KEY, category varchar NOT NULL, title varchar NOT NULL,
      excerpt text NOT NULL, content text NOT NULL, image_url text,
      published_at date, read_time varchar, created_at timestamptz NOT NULL DEFAULT now(),
      publication_status varchar NOT NULL DEFAULT 'published'
    );
    CREATE TABLE travel_packages (
      id varchar PRIMARY KEY, destination varchar NOT NULL, duration varchar NOT NULL,
      description text NOT NULL, starting_price varchar NOT NULL, highlights text[],
      image_url text, created_at timestamptz NOT NULL DEFAULT now(), price_amount numeric,
      currency char(3), category varchar
    );
    CREATE TABLE visa_services (
      id text PRIMARY KEY, country text NOT NULL, visa_type text NOT NULL,
      processing_time text, starting_from text, image_url text, documents text[]
    );
    INSERT INTO blog_posts (id, category, title, excerpt, content, image_url, published_at, read_time)
    VALUES ('db-blog', 'Guide', 'Database blog', 'DB excerpt', E'First paragraph.\\n\\nSecond paragraph.', 'https://example.com/blog.jpg', '2026-09-17', '4 min read');
    INSERT INTO blog_posts (id, category, title, excerpt, content, image_url, published_at, read_time, publication_status)
    VALUES ('db-draft', 'Guide', 'Draft blog', 'Draft excerpt', 'Draft content', NULL, '2026-09-18', '1 min read', 'draft');
    INSERT INTO travel_packages (id, destination, duration, description, starting_price, highlights, image_url, category)
    VALUES ('db-package', 'DB Journey', '3 Days', 'DB package description', 'From INR 12,000', ARRAY['Highlight A', 'Highlight B'], 'https://example.com/package.jpg', 'international');
    INSERT INTO visa_services (id, country, visa_type, processing_time, starting_from, image_url, documents)
    VALUES ('db-visa', 'DB Country', 'Tourist Visa', '5 days', 'From INR 2,000', 'https://example.com/visa.jpg', ARRAY['Passport', 'Photo']);
  `);

  originalPoolQuery = realPool.query;
  originalPoolConnect = realPool.connect;
  realPool.query = (text: string, values?: unknown[]) => database.query(text, values);
  realPool.connect = async () => ({ query: (text: string, values?: unknown[]) => database.query(text, values), release: () => undefined });

  Object.assign(env, {
    EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'test-email-key', EMAIL_FROM: 'LemonTrip <test@example.com>',
    OTP_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'test-twilio-token', OTP_SENDER: '+14155550100',
    GOOGLE_CLIENT_ID: 'test-google-client', GOOGLE_CLIENT_IDS: '',
  });
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.resend.com/emails')) {
      const body = JSON.parse(String(init?.body)) as { html: string };
      const match = body.html.match(/email\/verify\?token=([^&"]+)/);
      verificationToken = match ? decodeURIComponent(match[1]) : '';
      return new Response('{}', { status: 200 });
    }
    if (url.includes('/Messages.json')) {
      const body = new URLSearchParams(String(init?.body));
      const match = body.get('Body')?.match(/is (\d{6})\./);
      sentOtp = match?.[1] ?? '';
      return new Response('{}', { status: 201 });
    }
    return originalFetch(input, init);
  };

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  globalThis.fetch = originalFetch;
  realPool.query = originalPoolQuery;
  realPool.connect = originalPoolConnect;
  await database.close();
});

test('platform-bound access tokens distinguish app and website sessions', () => {
  const appToken = createAccessToken('user-id', 'app-session', 'app');
  const webToken = createAccessToken('user-id', 'website-session', 'website');
  const appClaims = jwt.verify(appToken, env.JWT_SECRET) as jwt.JwtPayload;
  const webClaims = jwt.verify(webToken, env.JWT_SECRET) as jwt.JwtPayload;

  assert.equal(appClaims.platform, 'app');
  assert.equal(webClaims.platform, 'website');
  assert.equal(appClaims.sub, webClaims.sub);
  assert.equal(Number(appClaims.exp) - Number(appClaims.iat), 900);
});

test('mobile authentication accepts a website legacy id claim for the same UUID user', async () => {
  const id = '00000000-0000-4000-8000-000000000099';
  await database.query(
    "INSERT INTO users (id, name, first_name, email, password_hash, email_verified, account_status) VALUES ($1, 'Shared User', 'Shared', 'shared-claim@example.com', 'hash', true, 'active')",
    [id],
  );
  const websiteStyleToken = jwt.sign({ id, email: 'shared-claim@example.com' }, env.JWT_SECRET, { expiresIn: '7d' });
  const response = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${websiteStyleToken}` } });
  assert.equal(response.status, 200);
  const result = await response.json() as { user: { id: string } };
  assert.equal(result.user.id, id);
});

test('content API maps blogs, packages, and visas from their dedicated tables', async () => {
  const [blogsResponse, packagesResponse, visasResponse] = await Promise.all(
    ['blog', 'package', 'visa'].map((type) => fetch(`${baseUrl}/api/content/${type}`)),
  );
  assert.equal(blogsResponse.status, 200);
  assert.equal(packagesResponse.status, 200);
  assert.equal(visasResponse.status, 200);

  const blogs = await blogsResponse.json() as { items: Array<{ id: string; title: string; content: string[] }> };
  const packages = await packagesResponse.json() as { items: Array<{ id: string; title: string; price: string; rating?: string }> };
  const visas = await visasResponse.json() as { items: Array<{ code: string; name: string; documents: string[] }> };
  assert.deepEqual(blogs.items[0], {
    id: 'db-blog', category: 'Guide', title: 'Database blog', excerpt: 'DB excerpt',
    image: 'https://example.com/blog.jpg', readingTime: '4 min read', date: 'Sep 17, 2026',
    content: ['First paragraph.', 'Second paragraph.'],
  });
  assert.deepEqual(blogs.items.map((post) => post.id), ['db-blog']);
  assert.equal(packages.items[0].title, 'DB Journey');
  assert.equal(packages.items[0].price, 'INR 12,000');
  assert.equal(packages.items[0].rating, undefined);
  assert.deepEqual(visas.items[0], {
    id: 'db-visa', code: 'db-visa', name: 'DB Country', image: 'https://example.com/visa.jpg',
    visaType: 'Tourist Visa', processing: '5 days', fee: 'INR 2,000', documents: ['Passport', 'Photo'],
  });
});

test('public mobile blog content rejects direct draft-id and slug paths', async () => {
  const draftId = await fetch(`${baseUrl}/api/content/blog/db-draft`);
  const draftSlug = await fetch(`${baseUrl}/api/content/blog/draft-blog-post`);
  assert.equal(draftId.status, 404);
  assert.equal(draftSlug.status, 404);
});

test('public mobile blog endpoint reports an unavailable publication schema clearly', async () => {
  await database.exec('ALTER TABLE blog_posts DROP COLUMN publication_status');
  const response = await fetch(`${baseUrl}/api/content/blog`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: 'Blog publication schema is unavailable. Apply the reviewed blog publication migration before serving public blog content.',
  });
});

test('refresh tokens are represented by one-way hashes', () => {
  const token = 'opaque-random-refresh-token';
  assert.notEqual(hashOpaqueToken(token), token);
  assert.equal(hashOpaqueToken(token), hashOpaqueToken(token));
  assert.notEqual(hashOpaqueToken(token), hashOpaqueToken(`${token}-different`));
});

test('passwords are verified only against their password hash', async () => {
  const hash = await hashPassword('a-long-test-password');
  assert.notEqual(hash, 'a-long-test-password');
  assert.equal(await verifyPassword('a-long-test-password', hash), true);
  assert.equal(await verifyPassword('incorrect-password', hash), false);
});

test('phone numbers normalize to E.164 and invalid numbers are rejected', () => {
  assert.equal(normalizePhone('+14155552671'), '+14155552671');
  assert.throws(() => normalizePhone('not-a-phone'));
});

test('authentication endpoints reject unsupported platform values', async () => {
  const cases = [
    ['/api/auth/signup', { firstName: 'Test', email: 'test@example.com', password: 'long-password', platform: 'desktop' }],
    ['/api/auth/login', { email: 'test@example.com', password: 'long-password', platform: 'desktop' }],
    ['/api/auth/otp/send', { phone: '+14155552671', purpose: 'login', platform: 'desktop' }],
    ['/api/auth/otp/verify', { phone: '+14155552671', code: '123456', purpose: 'login', platform: 'desktop' }],
    ['/api/auth/google', { idToken: 'a-valid-length-placeholder-token', platform: 'desktop' }],
  ] as const;

  for (const [path, body] of cases) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400, `${path} should reject invalid platform`);
  }
});

test('email signup stays pending until its single-use verification link is redeemed', async () => {
  const signup = await fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Mira', lastName: 'Sen', email: 'Mira@example.com', password: 'test-password-123', platform: 'website' }),
  });
  assert.equal(signup.status, 202);
  assert.equal((await signup.json() as { verificationRequired: boolean }).verificationRequired, true);
  assert.ok(verificationToken);
  const signupPlatform = await database.query<{ platform: string }>('SELECT platform FROM users WHERE email = $1', ['mira@example.com']);
  assert.equal(signupPlatform.rows[0].platform, 'website');

  const blockedLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'mira@example.com', password: 'test-password-123', platform: 'website' }),
  });
  assert.equal(blockedLogin.status, 403);

  const verified = await fetch(`${baseUrl}/api/auth/email/verify?token=${encodeURIComponent(verificationToken)}`);
  assert.equal(verified.status, 200);
  const verifiedPayload = await verified.json() as { user: Record<string, unknown> };
  assert.equal(verifiedPayload.user.emailVerified, true);
  assert.equal('password_hash' in verifiedPayload.user, false);
  assert.equal((await fetch(`${baseUrl}/api/auth/email/verify?token=${encodeURIComponent(verificationToken)}`)).status, 400);

  const duplicateSignup = await fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Mira', email: 'mira@example.com', password: 'another-test-password', platform: 'website' }),
  });
  assert.equal(duplicateSignup.status, 202);

  const websiteLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'mira@example.com', password: 'test-password-123', platform: 'website' }),
  });
  assert.equal(websiteLogin.status, 200);
  const websitePlatform = await database.query<{ platform: string }>('SELECT platform FROM users WHERE email = $1', ['mira@example.com']);
  assert.equal(websitePlatform.rows[0].platform, 'website');
  const appLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'mira@example.com', password: 'test-password-123', platform: 'app' }),
  });
  assert.equal(appLogin.status, 200);
  const webSession = await websiteLogin.json() as { user: { id: string }; platform: string; accessToken: string; refreshToken?: string };
  let appSession = await appLogin.json() as { user: { id: string }; platform: string; accessToken: string; refreshToken: string };
  assert.equal(webSession.user.id, appSession.user.id);
  assert.equal(webSession.platform, 'website');
  assert.equal(appSession.platform, 'app');
  const appPlatform = await database.query<{ platform: string }>('SELECT platform FROM users WHERE email = $1', ['mira@example.com']);
  assert.equal(appPlatform.rows[0].platform, 'app');
  assert.equal(webSession.refreshToken, undefined);
  const browserCookie = websiteLogin.headers.get('set-cookie')?.match(/lemontrip_refresh=([^;]+)/)?.[1];
  assert.ok(browserCookie);

  const refresh = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8081', Cookie: `lemontrip_refresh=${browserCookie}` },
    body: JSON.stringify({ platform: 'website' }),
  });
  assert.equal(refresh.status, 200);
  const rotated = await refresh.json() as { accessToken: string; refreshToken?: string };
  assert.equal(rotated.refreshToken, undefined);
  const rotatedCookie = refresh.headers.get('set-cookie')?.match(/lemontrip_refresh=([^;]+)/)?.[1];
  assert.ok(rotatedCookie);
  const rejectedOrigin = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example', Cookie: `lemontrip_refresh=${rotatedCookie}` },
    body: JSON.stringify({ platform: 'website' }),
  });
  assert.equal(rejectedOrigin.status, 403);
  const appRefresh = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: appSession.refreshToken, platform: 'app' }),
  });
  assert.equal(appRefresh.status, 200);
  const appRotated = await appRefresh.json() as { accessToken: string; refreshToken: string };
  assert.notEqual(appRotated.refreshToken, appSession.refreshToken);
  appSession = { ...appSession, accessToken: appRotated.accessToken, refreshToken: appRotated.refreshToken };
  assert.equal((await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8081', Cookie: `lemontrip_refresh=${browserCookie}` },
    body: JSON.stringify({ platform: 'website' }),
  })).status, 401);

  const loggedOut = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${rotated.accessToken}` } });
  assert.equal(loggedOut.status, 204);
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${rotated.accessToken}` } })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${appSession.accessToken}` } })).status, 200);
  const logoutAll = await fetch(`${baseUrl}/api/auth/logout-all`, { method: 'POST', headers: { Authorization: `Bearer ${appSession.accessToken}` } });
  assert.equal(logoutAll.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${appSession.accessToken}` } })).status, 401);
});

test('phone signup creates no account until OTP verification and returns no OTP', async () => {
  const phone = '+14155552672';
  const sent = await fetch(`${baseUrl}/api/auth/otp/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, purpose: 'signup', name: 'Dev Patel', platform: 'app' }),
  });
  assert.equal(sent.status, 202);
  const responseBody = await sent.text();
  assert.ok(sentOtp);
  assert.equal(responseBody.includes(sentOtp), false);
  const beforeVerify = await database.query('SELECT id FROM users WHERE phone = $1', [phone]);
  assert.equal(beforeVerify.rowCount, 0);

  const wrong = await fetch(`${baseUrl}/api/auth/otp/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code: '000000', purpose: 'signup', platform: 'app' }),
  });
  assert.equal(wrong.status, 400);
  const verified = await fetch(`${baseUrl}/api/auth/otp/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code: sentOtp, purpose: 'signup', platform: 'app' }),
  });
  assert.equal(verified.status, 200);
  const session = await verified.json() as { user: { id: string; phoneVerified: boolean; email: string | null }; accessToken: string };
  assert.equal(session.user.phoneVerified, true);
  assert.equal(session.user.email, null);
  const signupPlatform = await database.query<{ platform: string }>('SELECT platform FROM users WHERE phone = $1', [phone]);
  assert.equal(signupPlatform.rows[0].platform, 'app');
  assert.equal((await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${session.accessToken}` } })).status, 200);
});

test('incorrect and expired OTPs are rejected and attempts are capped', async () => {
  const phone = '+14155552673';
  const otpPurpose = 'phone_login';
  const codeHash = createHmac('sha256', env.JWT_REFRESH_SECRET ?? env.JWT_SECRET).update(`${phone}:${otpPurpose}:123456`).digest('hex');
  await database.query("INSERT INTO otp_verifications (phone, purpose, platform, code_hash, expires_at) VALUES ($1, $2, 'app', $3, now() + interval '5 minutes')", [phone, otpPurpose, codeHash]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/auth/otp/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, code: '000000', purpose: 'login', platform: 'app' }),
    });
    assert.equal(response.status, 400);
  }
  const capped = await fetch(`${baseUrl}/api/auth/otp/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code: '000000', purpose: 'login', platform: 'app' }),
  });
  assert.equal(capped.status, 429);

  const expiredPhone = '+14155552674';
  const expiredHash = createHmac('sha256', env.JWT_REFRESH_SECRET ?? env.JWT_SECRET).update(`${expiredPhone}:${otpPurpose}:123456`).digest('hex');
  await database.query("INSERT INTO otp_verifications (phone, purpose, platform, code_hash, expires_at) VALUES ($1, $2, 'website', $3, now() - interval '1 second')", [expiredPhone, otpPurpose, expiredHash]);
  const expired = await fetch(`${baseUrl}/api/auth/otp/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: expiredPhone, code: '123456', purpose: 'login', platform: 'website' }),
  });
  assert.equal(expired.status, 400);
  assert.match((await expired.json() as { error: string }).error, /expired/i);
});

test('expired email verification tokens cannot activate accounts', async () => {
  const user = await database.query<{ id: string }>(
    "INSERT INTO users (name, first_name, email, password_hash, account_status) VALUES ('Expired User', 'Expired', 'expired@example.com', 'hash', 'pending') RETURNING id",
  );
  const tokenHash = hashOpaqueToken('e'.repeat(48));
  await database.query("INSERT INTO email_verifications (user_id, platform, token_hash, expires_at) VALUES ($1, 'website', $2, now() - interval '1 second')", [user.rows[0].id, tokenHash]);
  const response = await fetch(`${baseUrl}/api/auth/email/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'e'.repeat(48) }),
  });
  assert.equal(response.status, 400);
  const row = await database.query<{ account_status: string; email_verified: boolean }>('SELECT account_status, email_verified FROM users WHERE id = $1', [user.rows[0].id]);
  assert.deepEqual(row.rows[0], { account_status: 'pending', email_verified: false });
});

test('OTP resend cap is enforced and normalized duplicate phones are not re-registered', async () => {
  const phone = '+14155552675';
  for (let index = 0; index < 3; index += 1) {
    await database.query("INSERT INTO otp_verifications (phone, purpose, platform, code_hash, expires_at) VALUES ($1, 'phone_signup', 'website', $2, now() + interval '5 minutes')", [phone, `hash-${index}`]);
  }
  const capped = await fetch(`${baseUrl}/api/auth/otp/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, purpose: 'signup', name: 'Resend Test', platform: 'website' }),
  });
  assert.equal(capped.status, 429);

  const duplicate = await fetch(`${baseUrl}/api/auth/otp/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '+1 (415) 555-2672', purpose: 'signup', name: 'Duplicate', platform: 'app' }),
  });
  assert.equal(duplicate.status, 202);
});

test('Google signup, repeat login, and verified existing-account linking share one user', async () => {
  nock('https://www.googleapis.com')
    .get('/oauth2/v1/certs')
    .reply(200, { 'lemontrip-test-key': googleCertificate }, { 'Cache-Control': 'public, max-age=3600' });

  const googleToken = signedGoogleToken('google-subject-1', 'google@example.com');
  const googleSignup = await fetch(`${baseUrl}/api/auth/google`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: googleToken, platform: 'app' }),
  });
  assert.equal(googleSignup.status, 200);
  const firstSession = await googleSignup.json() as { user: { id: string; emailVerified: boolean }; accessToken: string };
  assert.equal(firstSession.user.emailVerified, true);

  const googleLogin = await fetch(`${baseUrl}/api/auth/google`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: googleToken, platform: 'website' }),
  });
  assert.equal(googleLogin.status, 200);
  const secondSession = await googleLogin.json() as { user: { id: string }; platform: string };
  assert.equal(secondSession.user.id, firstSession.user.id);
  assert.equal(secondSession.platform, 'website');
  const googlePlatform = await database.query<{ platform: string }>('SELECT platform FROM users WHERE email = $1', ['google@example.com']);
  assert.equal(googlePlatform.rows[0].platform, 'website');

  const existing = await database.query<{ id: string }>(
    "INSERT INTO users (name, first_name, email, password_hash, email_verified, account_status) VALUES ('Existing Person', 'Existing', 'existing-google@example.com', 'hash', true, 'active') RETURNING id",
  );
  const existingToken = signedGoogleToken('google-subject-2', 'existing-google@example.com');
  const linked = await fetch(`${baseUrl}/api/auth/google`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: existingToken, platform: 'website' }),
  });
  assert.equal(linked.status, 200);
  const linkedSession = await linked.json() as { user: { id: string } };
  assert.equal(linkedSession.user.id, existing.rows[0].id);
  const accounts = await database.query<{ count: number }>('SELECT count(*)::int AS count FROM users WHERE email = $1', ['existing-google@example.com']);
  assert.equal(accounts.rows[0].count, 1);

  const unverified = await database.query<{ id: string }>(
    "INSERT INTO users (name, first_name, email, password_hash, account_status) VALUES ('Unverified Person', 'Unverified', 'unverified-google@example.com', 'hash', 'active') RETURNING id",
  );
  const unverifiedToken = signedGoogleToken('google-subject-3', 'unverified-google@example.com');
  const linkedUnverified = await fetch(`${baseUrl}/api/auth/google`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: unverifiedToken, platform: 'app' }),
  });
  assert.equal(linkedUnverified.status, 200);
  const verifiedSession = await linkedUnverified.json() as { user: { id: string; emailVerified: boolean } };
  assert.equal(verifiedSession.user.id, unverified.rows[0].id);
  assert.equal(verifiedSession.user.emailVerified, true);
  const links = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM oauth_accounts WHERE user_id = $1", [unverified.rows[0].id]);
  assert.equal(links.rows[0].count, 1);
});
