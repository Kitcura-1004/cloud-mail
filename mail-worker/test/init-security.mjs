import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = path.join(root, 'node_modules/.pnpm');
const { Miniflare } = await import(pathToFileURL(path.join(
	pnpm,
	'miniflare@4.20260507.1/node_modules/miniflare/dist/src/index.js'
)).href);

const scratch = path.join(root, '.init-bundle');
await rm(scratch, { recursive: true, force: true });
const configPath = path.join(root, 'wrangler.init-test.toml');
await writeFile(configPath, `name = "cloud-mail-init-test"
main = "src/index.js"
compatibility_date = "2025-06-04"
`);
try {
	execFileSync('pnpm', [
		'exec', 'wrangler', 'deploy', '--dry-run',
		'--outdir', scratch,
		'--config', 'wrangler.init-test.toml',
		'--minify', 'false',
	], {
		cwd: root,
		stdio: 'inherit',
		env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
	});
} finally {
	await rm(configPath, { force: true });
}
const bundled = await readFile(path.join(scratch, 'index.js'), 'utf8');
const bundlePath = path.join(scratch, 'worker.js');
await writeFile(bundlePath, bundled.replace(/\n\/\/# sourceMappingURL=.*$/u, '\n'));
await rm(path.join(scratch, 'index.js'), { force: true });
await rm(path.join(scratch, 'index.js.map'), { force: true });

const JWT = 'init-fixture-secret';
const ADMIN = 'owner@seun.studio';
const PASS_A = 'fixture-pass-1';
const PASS_B = 'fixture-pass-2';

const results = [];

function record(name, ok, detail) {
	results.push({ name, ok, detail });
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function digest(salt, password) {
	const bytes = new TextEncoder().encode(salt + password);
	const buf = await webcrypto.subtle.digest('SHA-256', bytes);
	return Buffer.from(buf).toString('base64');
}

function workerOptions(bindings, label, persist) {
	return {
		scriptPath: bundlePath,
		modules: true,
		compatibilityDate: '2025-06-04',
		d1Databases: { db: `db-${label}` },
		kvNamespaces: { kv: `kv-${label}` },
		d1Persist: persist,
		kvPersist: persist,
		bindings,
	};
}

async function boot(bindings, label) {
	const persist = await mkdtemp(path.join(tmpdir(), `cm-init-${label}-`));
	const mf = new Miniflare(workerOptions(bindings, label, persist));
	try {
		await mf.ready;
	} catch (error) {
		await mf.dispose();
		throw error;
	}
	return { mf, persist, label };
}

async function rebind(session, bindings) {
	await session.mf.setOptions(workerOptions(bindings, session.label, session.persist));
}

async function shutdown(session) {
	await session.mf.dispose();
	await rm(session.persist, { recursive: true, force: true });
}

async function init(mf, secret = JWT) {
	const response = await mf.dispatchFetch(`http://mail.test/api/init/${secret}`);
	return { status: response.status, text: await response.text() };
}

async function tryRegister(mf, email) {
	const before = await countUsers(mf);
	const response = await mf.dispatchFetch('http://mail.test/api/register', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email, password: PASS_B }),
	});
	const after = await countUsers(mf);
	return { status: response.status, body: await response.text(), created: after > before };
}

async function db(mf) {
	return mf.getD1Database('db');
}

async function settingRow(mf) {
	return (await db(mf)).prepare('SELECT register FROM setting').first();
}

async function settingKv(mf) {
	const kv = await mf.getKVNamespace('kv');
	return kv.get('setting:');
}

async function users(mf, email = ADMIN) {
	const result = await (await db(mf)).prepare(
		'SELECT user_id, email, password, salt, is_del FROM user WHERE email = ? COLLATE NOCASE'
	).bind(email).all();
	return result.results || [];
}

async function accounts(mf, email = ADMIN) {
	const result = await (await db(mf)).prepare(
		'SELECT account_id, email, user_id, is_del FROM account WHERE email = ? COLLATE NOCASE'
	).bind(email).all();
	return result.results || [];
}

async function countUsers(mf) {
	const row = await (await db(mf)).prepare('SELECT COUNT(*) AS n FROM user').first();
	return Number(row?.n || 0);
}

async function freshAdmin() {
	const session = await boot({
		jwt_secret: JWT,
		admin: ADMIN,
		domain: ['seun.studio'],
		admin_password: PASS_A,
	}, 'fresh');
	try {
		const created = await init(session.mf);
		const rows = await users(session.mf);
		const boxes = await accounts(session.mf);
		const setting = await settingRow(session.mf);
		const kv = await settingKv(session.mf);
		const parsed = kv ? JSON.parse(kv) : null;
		const hashOk = rows.length === 1 && await digest(rows[0].salt, PASS_A) === rows[0].password;
		const registered = await tryRegister(session.mf, 'stranger@seun.studio');
		const ok = created.text === 'success'
			&& rows.length === 1
			&& rows[0].email === ADMIN
			&& Number(rows[0].is_del) === 0
			&& hashOk
			&& boxes.length === 1
			&& Number(boxes[0].user_id) === Number(rows[0].user_id)
			&& Number(setting?.register) === 1
			&& Number(parsed?.register) === 1
			&& registered.created === false;
		record('fresh empty database creates admin and closes registration', ok,
			ok ? '' : `init=${created.text} users=${rows.length} register=${setting?.register} kv=${parsed?.register} regCreated=${registered.created}`);
	} finally {
		await shutdown(session);
	}
}

async function missingPassword() {
	const session = await boot({
		jwt_secret: JWT,
		admin: ADMIN,
		domain: ['seun.studio'],
	}, 'nopass');
	try {
		const created = await init(session.mf);
		const kv = await settingKv(session.mf);
		const setting = await settingRow(session.mf);
		const registered = await tryRegister(session.mf, 'stranger@seun.studio');
		const ok = created.text === 'admin not provisioned'
			&& kv == null
			&& Number(setting?.register) === 1
			&& registered.created === false
			&& (await users(session.mf)).length === 0;
		record('missing admin_password does not publish settings and blocks registration', ok,
			ok ? '' : `init=${created.text} kv=${kv} register=${setting?.register} regCreated=${registered.created}`);
	} finally {
		await shutdown(session);
	}
}

async function keepsExistingPassword() {
	const session = await boot({
		jwt_secret: JWT,
		admin: ADMIN,
		domain: ['seun.studio'],
		admin_password: PASS_A,
	}, 'keep');
	try {
		await init(session.mf);
		const before = (await users(session.mf))[0];
		await rebind(session, {
			jwt_secret: JWT,
			admin: ADMIN,
			domain: ['seun.studio'],
			admin_password: PASS_B,
		});
		const again = await init(session.mf);
		const after = (await users(session.mf))[0];
		const ok = again.text === 'success'
			&& after.password === before.password
			&& after.salt === before.salt
			&& await digest(after.salt, PASS_A) === after.password
			&& await digest(after.salt, PASS_B) !== after.password
			&& (await users(session.mf)).length === 1;
		record('existing admin password is left unchanged', ok,
			ok ? '' : `init=${again.text} sameHash=${after?.password === before?.password}`);
	} finally {
		await shutdown(session);
	}
}

async function restoresDeletedAdmin() {
	const session = await boot({
		jwt_secret: JWT,
		admin: ADMIN,
		domain: ['seun.studio'],
		admin_password: PASS_A,
	}, 'restore');
	try {
		await init(session.mf);
		const original = (await users(session.mf))[0];
		await (await db(session.mf)).prepare('UPDATE user SET is_del = 1 WHERE user_id = ?').bind(original.user_id).run();
		await (await db(session.mf)).prepare('UPDATE account SET is_del = 1 WHERE email = ?').bind(ADMIN).run();
		await rebind(session, {
			jwt_secret: JWT,
			admin: ADMIN,
			domain: ['seun.studio'],
			admin_password: PASS_B,
		});
		const again = await init(session.mf);
		const rows = await users(session.mf);
		const boxes = await accounts(session.mf);
		const ok = again.text === 'success'
			&& rows.length === 1
			&& Number(rows[0].user_id) === Number(original.user_id)
			&& Number(rows[0].is_del) === 0
			&& await digest(rows[0].salt, PASS_B) === rows[0].password
			&& boxes.length === 1
			&& Number(boxes[0].is_del) === 0
			&& Number(boxes[0].user_id) === Number(original.user_id);
		record('soft-deleted admin is restored without a duplicate', ok,
			ok ? '' : `init=${again.text} users=${rows.length} accounts=${boxes.length}`);
	} finally {
		await shutdown(session);
	}
}

async function rejectsOccupiedMailbox() {
	const session = await boot({
		jwt_secret: JWT,
		admin: ADMIN,
		domain: ['seun.studio'],
		admin_password: PASS_A,
	}, 'occupied');
	try {
		await init(session.mf);
		const database = await db(session.mf);
		await database.prepare('DELETE FROM user WHERE email = ?').bind(ADMIN).run();
		const other = await database.prepare(
			`INSERT INTO user (email, type, password, salt, status, is_del, reg_key_id, send_count, sort)
			 VALUES ('other@seun.studio', 1, 'hash', 'salt', 0, 0, 0, 0, 0)`
		).run();
		const otherId = other.meta.last_row_id;
		await database.prepare('UPDATE account SET user_id = ? WHERE email = ?').bind(otherId, ADMIN).run();
		const kv = await session.mf.getKVNamespace('kv');
		await kv.delete('setting:');
		const again = await init(session.mf);
		const adminRows = await users(session.mf);
		const boxes = await accounts(session.mf);
		const registered = await tryRegister(session.mf, 'stranger@seun.studio');
		const ok = again.text === 'admin mailbox occupied'
			&& adminRows.length === 0
			&& boxes.length === 1
			&& Number(boxes[0].user_id) === Number(otherId)
			&& (await settingKv(session.mf)) == null
			&& registered.created === false;
		record('occupied admin mailbox is rejected', ok,
			ok ? '' : `init=${again.text} adminUsers=${adminRows.length} owner=${boxes[0]?.user_id} regCreated=${registered.created}`);
	} finally {
		await shutdown(session);
	}
}

async function missingBindings() {
	const noAdmin = await boot({
		jwt_secret: JWT,
		domain: ['seun.studio'],
		admin_password: PASS_A,
	}, 'noadmin');
	try {
		const created = await init(noAdmin.mf);
		const registered = await tryRegister(noAdmin.mf, 'stranger@seun.studio');
		const ok = created.text === 'admin binding missing'
			&& await settingKv(noAdmin.mf) == null
			&& Number((await settingRow(noAdmin.mf))?.register) === 1
			&& registered.created === false;
		record('missing admin binding does not open registration', ok,
			ok ? '' : `init=${created.text} regCreated=${registered.created}`);
	} finally {
		await shutdown(noAdmin);
	}

	const noDomain = await boot({
		jwt_secret: JWT,
		admin: ADMIN,
		admin_password: PASS_A,
	}, 'nodomain');
	try {
		const created = await init(noDomain.mf);
		const registered = await tryRegister(noDomain.mf, 'stranger@seun.studio');
		const ok = created.text === 'admin domain mismatch'
			&& await settingKv(noDomain.mf) == null
			&& Number((await settingRow(noDomain.mf))?.register) === 1
			&& registered.created === false;
		record('missing domain binding does not open registration', ok,
			ok ? '' : `init=${created.text} regCreated=${registered.created}`);
	} finally {
		await shutdown(noDomain);
	}
}

const cases = [
	freshAdmin,
	missingPassword,
	keepsExistingPassword,
	restoresDeletedAdmin,
	rejectsOccupiedMailbox,
	missingBindings,
];

for (const run of cases) {
	try {
		await run();
	} catch (error) {
		record(run.name, false, error?.stack || String(error));
	}
}

const failed = results.filter((item) => !item.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed, ${results.length} total`);
await rm(scratch, { recursive: true, force: true });
process.exitCode = failed === 0 ? 0 : 1;
