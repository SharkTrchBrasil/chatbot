import crypto from 'crypto';

const MAX_SKEW_MS = 5 * 60 * 1000;
const usedNonces = new Set();
let nonceCleanupRef = null;

const startNonceCleanup = () => {
	if (nonceCleanupRef) return;
	nonceCleanupRef = setInterval(() => usedNonces.clear(), 10 * 60 * 1000);
};

export const stopNonceCleanup = () => {
	if (nonceCleanupRef) {
		clearInterval(nonceCleanupRef);
		nonceCleanupRef = null;
	}
};

export function verifyHmacSignature(headerSecretEnv = 'CHATBOT_WEBHOOK_SECRET') {
	startNonceCleanup();
	return (req, res, next) => {
		const secret = process.env[headerSecretEnv];
		const signature = req.header('x-signature');
		const timestamp = req.header('x-timestamp');
		const nonce = req.header('x-nonce');

		if (!secret || !signature || !timestamp || !nonce) {
			return res.status(403).json({ error: 'Unauthorized' });
		}

		if (usedNonces.has(nonce)) {
			return res.status(409).json({ error: 'Replay detected' });
		}

		const tsNum = Number(timestamp);
		const diff = Math.abs(Date.now() - tsNum);
		if (!Number.isFinite(tsNum) || diff > MAX_SKEW_MS) {
			return res.status(408).json({ error: 'Expired signature' });
		}

		const bodyString = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
		const payload = `${timestamp}.${nonce}.${bodyString}`;
		const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

		const a = Buffer.from(expected);
		const b = Buffer.from(signature);
		if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
			return res.status(403).json({ error: 'Invalid signature' });
		}

		usedNonces.add(nonce);
		next();
	};
}

export default verifyHmacSignature;



