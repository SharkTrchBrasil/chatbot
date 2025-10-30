import axios from 'axios';
import crypto from 'crypto';

const breakers = new Map();

const defaultConfig = {
	failureThreshold: 5,
	cooldownMs: 30000,
	successHalfOpen: 2,
};

function getBreaker(key) {
	if (!breakers.has(key)) {
		breakers.set(key, { state: 'CLOSED', failures: 0, lastOpenedAt: 0, halfOpenSuccess: 0 });
	}
	return breakers.get(key);
}

function signBody(secret, body) {
	const timestamp = Date.now().toString();
	const nonce = crypto.randomUUID();
	const payload = `${timestamp}.${nonce}.${body}`;
	const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
	return { signature, timestamp, nonce };
}

function jitter(base) {
	const spread = Math.min(1000, base * 0.1);
	return base + Math.floor(Math.random() * spread);
}

async function withBreaker(key, fn) {
	const b = getBreaker(key);
	if (b.state === 'OPEN') {
		if (Date.now() - b.lastOpenedAt < defaultConfig.cooldownMs) {
			const err = new Error('Circuit open');
			err.code = 'CIRCUIT_OPEN';
			throw err;
		}
		b.state = 'HALF_OPEN';
		b.halfOpenSuccess = 0;
	}
	try {
		const res = await fn();
		if (b.state === 'HALF_OPEN') {
			b.halfOpenSuccess += 1;
			if (b.halfOpenSuccess >= defaultConfig.successHalfOpen) {
				b.state = 'CLOSED';
				b.failures = 0;
			}
		} else {
			b.failures = 0;
		}
		return res;
	} catch (e) {
		b.failures += 1;
		if (b.failures >= defaultConfig.failureThreshold) {
			b.state = 'OPEN';
			b.lastOpenedAt = Date.now();
		}
		throw e;
	}
}

export async function postJsonSigned(url, data, secret, correlationId, timeout = 30000) {
	const body = JSON.stringify(data || {});
	const { signature, timestamp, nonce } = signBody(secret, body);
	const key = new URL(url).origin;
	return withBreaker(key, async () => {
		let attempt = 1;
		const max = 3;
		while (true) {
			try {
				return await axios.post(url, body, {
					headers: {
						'Content-Type': 'application/json',
						'x-signature': signature,
						'x-timestamp': timestamp,
						'x-nonce': nonce,
						'x-correlation-id': correlationId
					},
					timeout
				});
			} catch (err) {
				const retriable = !err.response || err.response.status >= 500;
				if (!retriable || attempt >= max) throw err;
				await new Promise(r => setTimeout(r, jitter(1000 * attempt)));
				attempt += 1;
			}
		}
	});
}

export async function postFormSigned(url, form, secret, correlationId, timeout = 30000, fields = []) {
	// Sign stable metadata derived from form field names (sorted)
	const meta = { fields: Array.isArray(fields) ? [...fields].sort() : [] };
	const bodyForSigning = JSON.stringify(meta);
	const { signature, timestamp, nonce } = signBody(secret, bodyForSigning);
	const key = new URL(url).origin;
	return withBreaker(key, async () => {
		let attempt = 1;
		const max = 3;
		while (true) {
			try {
				return await axios.post(url, form, {
					headers: {
						...form.getHeaders(),
						'x-signature': signature,
						'x-timestamp': timestamp,
						'x-nonce': nonce,
						'x-correlation-id': correlationId
					},
					timeout,
					maxContentLength: 20 * 1024 * 1024,
					maxBodyLength: 20 * 1024 * 1024
				});
			} catch (err) {
				const retriable = !err.response || err.response.status >= 500;
				if (!retriable || attempt >= max) throw err;
				await new Promise(r => setTimeout(r, jitter(1000 * attempt)));
				attempt += 1;
			}
		}
	});
}

export function breakerStats() {
	const out = {};
	for (const [k, v] of breakers.entries()) {
		out[k] = { state: v.state, failures: v.failures, lastOpenedAt: v.lastOpenedAt };
	}
	return out;
}


