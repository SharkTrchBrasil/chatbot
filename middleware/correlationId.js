import crypto from 'crypto';

export const correlationIdMiddleware = (req, res, next) => {
	const incoming = req.header('x-correlation-id');
	const id = incoming && typeof incoming === 'string' && incoming.length <= 128
		? incoming
		: crypto.randomUUID();
	res.setHeader('x-correlation-id', id);
	req.correlationId = id;
	next();
};

export default correlationIdMiddleware;



