import { cacheManager } from './cacheService.js';
import { executeQuery, executeQueryMany } from '../config/database.js';

export async function getStoreReadModel(storeId) {
	const key = `storeRM:${storeId}`;
	const cached = await cacheManager.get('readModels', key);
	if (cached.found) return cached.value;

	const dayOfWeek = new Date().getDay();
	const [nameRow, hours, slugRow, coupons, addressRow] = await Promise.all([
		executeQuery('SELECT name FROM stores WHERE id = $1', [storeId]),
		executeQuery('SELECT open_time, close_time FROM store_hours WHERE store_id = $1 AND day_of_week = $2', [storeId, dayOfWeek]),
		executeQuery('SELECT url_slug FROM stores WHERE id = $1', [storeId]),
		executeQueryMany('SELECT code, description FROM coupons WHERE store_id = $1 AND is_active = TRUE AND start_date <= NOW() AND end_date >= NOW()', [storeId]),
		executeQuery('SELECT street, number, neighborhood, city FROM stores WHERE id = $1', [storeId])
	]);

	const value = {
		name: nameRow?.name || 'Unknown Store',
		hours,
		slug: slugRow?.url_slug || null,
		coupons,
		address: addressRow ? `${addressRow.street}, ${addressRow.number} - ${addressRow.neighborhood}, ${addressRow.city}` : 'Endereço não configurado.'
	};

	await cacheManager.set('readModels', key, value, 300);
	return value;
}



