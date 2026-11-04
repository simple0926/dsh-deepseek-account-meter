/**
 * Host half of the DeepSeek account meter.
 *
 * It owns two derived snapshots — the signed-in DeepSeek wallet balance (from
 * `ctx.deepseekAccount`) and the account-wide token totals composed from the
 * per-session `tokenUsage` projection — and publishes both as one JSON
 * document over a loopback-only `webServer` route. The Client half polls that
 * route and renders it under the composer.
 *
 * Neither snapshot is authoritative: `deepseekAccount` owns the balance and the
 * session logs own usage. Everything cached here is derived, recomputable, and
 * safe to drop; the running totals are maintained incrementally from the
 * projection change feed so no log is ever rescanned.
 */

/** Cordis plugin name. */
export const name = 'deepseek-account-meter'

/** The browser carrier is the whole delivery path; without it the plugin stays pending. */
export const inject = ['webServer']

/** The projection unit that folds whole-log token usage (`@deepseek-ai/dsh-token-meter`). */
const USAGE_KEY = 'tokenUsage'

/** The four wire buckets of one usage view. */
const BUCKETS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

/** Backoff before retrying a seed whose services were not ready yet. */
const SEED_RETRY_MS = 5_000

/** Route path, cache windows, and the client metadata sent to Platform. */
const DEFAULTS = {
	path: '/dsh-deepseek-account-meter/summary',
	/** Balance costs one Platform round trip and DSH itself never polls it. */
	balanceTtlMs: 60_000,
	/** Retry a failed balance read sooner than a successful one. */
	balanceErrorTtlMs: 15_000,
	/** No Host service exposes the running app version, so it is a config value. */
	clientVersion: '0.2.1-rc.5',
	/** UI language sent to Platform (primary subtag selects the wire locale). */
	locale: 'zh-CN',
}

/** Loopback addresses a same-machine browser page can present. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Refuse requests that did not originate on this machine: the payload contains
 * account balance, and a declared route on a wildcard bind has no admission
 * layer behind it.
 * @param req - the incoming request.
 * @returns whether the peer is loopback.
 */
function isLoopback(req) {
	const address = req.socket && req.socket.remoteAddress
	if (!address) return true
	return LOOPBACK.has(address)
}

/**
 * Write one JSON response.
 * @param res - the node response.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
	const body = JSON.stringify(payload)
	res.statusCode = status
	res.setHeader('content-type', 'application/json; charset=utf-8')
	res.setHeader('cache-control', 'no-store')
	res.setHeader('content-length', String(Buffer.byteLength(body)))
	res.end(body)
}

/**
 * Read a non-negative counter.
 * @param value - stored or projected value.
 * @returns a finite non-negative number.
 */
function counter(value) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Normalize one `tokenUsage` view into the four buckets. The persisted
 * projection state nests them under `totals`; the wire view is flat. Accepting
 * both keeps the aggregate working across either representation.
 * @param view - a projection value.
 * @returns the four buckets, or null when the value is not a usage view.
 */
function bucketsOf(view) {
	if (!view || typeof view !== 'object') return null
	const source = view.totals && typeof view.totals === 'object' ? view.totals : view
	const buckets = {}
	for (const key of BUCKETS) buckets[key] = counter(source[key])
	return buckets
}

/**
 * Compare two bucket records.
 * @param left - previous value.
 * @param right - next value.
 * @returns whether every bucket is equal.
 */
function sameBuckets(left, right) {
	if (!left || !right) return false
	for (const key of BUCKETS) if (left[key] !== right[key]) return false
	return true
}

/**
 * Install the meter.
 * @param ctx - the plugin context.
 * @param config - optional overrides of {@link DEFAULTS}.
 */
export function apply(ctx, config) {
	const settings = { ...DEFAULTS, ...(config === null || typeof config !== 'object' ? {} : config) }

	/** Last balance snapshot plus when it was taken. */
	let balanceCache = { at: 0, value: null }
	/** Deduplicates concurrent balance reads. */
	let balanceInflight = null

	/** Latest absolute usage buckets per stored session. */
	const perSession = new Map()
	/** Running sum of {@link perSession}. */
	const totals = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
	/** Whether the initial seed completed. */
	let usageSeeded = false
	/** Why the last seed produced nothing, when it failed. */
	let usageError = null
	/** When the totals last changed. */
	let usageUpdatedAt = 0
	/** Deduplicates concurrent seeds and force re-seeds. */
	let seedInflight = null
	/** Earliest time a seed that failed for want of a service may run again. */
	let seedRetryAt = 0

	/**
	 * Client metadata Platform receives as request headers. Sampled per call so
	 * the timezone offset follows the host, not plugin load time.
	 * @returns the metadata for one account read.
	 */
	const clientMetadata = () => ({
		version: settings.clientVersion,
		locale: settings.locale,
		timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
	})

	/**
	 * Read the account balance, honoring the cache unless `force` is set.
	 * @param force - bypass a fresh cache entry.
	 * @returns the balance snapshot.
	 */
	const readBalance = (force) => {
		const ttl = balanceCache.value && balanceCache.value.status === 'failed' ? settings.balanceErrorTtlMs : settings.balanceTtlMs
		if (!force && balanceCache.at !== 0 && Date.now() - balanceCache.at < ttl) return Promise.resolve(balanceCache.value)
		if (balanceInflight) return balanceInflight
		balanceInflight = (async () => {
			const account = ctx.get('deepseekAccount')
			if (!account) return { status: 'unavailable' }
			let state
			try {
				state = await account.getState()
			} catch {
				return { status: 'failed', links: null }
			}
			const links = (state && state.links) || null
			if (!state || state.status !== 'credential-stored') return { status: 'signed-out', links }
			try {
				const balance = await account.getBalance(clientMetadata())
				// null means the grant was absent or rejected (the Host already revoked it).
				if (balance === null) return { status: 'signed-out', links }
				if (balance.status !== 'ready') return { status: 'failed', links }
				return {
					status: 'ready',
					wallets: balance.value || [],
					bonusWallets: balance.bonusWallets || [],
					links,
					fetchedAt: Date.now(),
				}
			} catch {
				return { status: 'failed', links }
			}
		})()
			.then((value) => {
				balanceCache = { at: Date.now(), value }
				return value
			})
			.finally(() => {
				balanceInflight = null
			})
		return balanceInflight
	}

	/**
	 * Store one session's absolute buckets and move the running total by the delta.
	 * Absolute values make the aggregate self-healing: a re-read can never double count.
	 * @param id - session id.
	 * @param buckets - the session's latest usage view.
	 */
	const setSession = (id, buckets) => {
		const previous = perSession.get(id)
		if (sameBuckets(previous, buckets)) return
		for (const key of BUCKETS) totals[key] += buckets[key] - (previous ? previous[key] : 0)
		perSession.set(id, buckets)
		usageUpdatedAt = Date.now()
	}

	/** Recompute the running total from the per-session map. */
	const recomputeTotals = () => {
		for (const key of BUCKETS) totals[key] = 0
		for (const buckets of perSession.values()) {
			for (const key of BUCKETS) totals[key] += buckets[key]
		}
		usageUpdatedAt = Date.now()
	}

	/**
	 * Read one stored-or-live session's usage view without touching a log file:
	 * live sessions fold exactly from the projection registry, cold sessions take
	 * the persisted cache row.
	 * @param header - the stored session header.
	 * @returns the usage view, or undefined when neither source has one.
	 */
	const usageViewOf = (header) => {
		const projections = ctx.get('sessionProjections')
		const cache = ctx.get('sessionProjectionCache')
		const sessions = ctx.get('sessions')
		const live = sessions && typeof sessions.get === 'function' ? sessions.get(header.id) : undefined
		if (live && projections) {
			try {
				const value = projections.snapshot(live, [USAGE_KEY]).values[USAGE_KEY]
				if (value) return value
			} catch {
				/* fall through to the cache row */
			}
		}
		if (cache) {
			try {
				const value = cache.cachedSnapshot(header, [USAGE_KEY]).values[USAGE_KEY]
				if (value) return value
			} catch {
				/* no usable row */
			}
		}
		return undefined
	}

	/**
	 * Seed every stored session once, then let the change feed keep it current.
	 * A missing service is retried on a later request rather than cached as empty,
	 * because plugins activate in an order that can put this one first.
	 * @returns a promise settling after the map and totals are rebuilt.
	 */
	const seedUsage = () => {
		if (seedInflight) return seedInflight
		seedInflight = (async () => {
			const persistence = ctx.get('sessionPersistence')
			if (!persistence || typeof persistence.list !== 'function') {
				usageError = 'sessionPersistence unavailable'
				seedRetryAt = Date.now() + SEED_RETRY_MS
				return
			}
			let snapshots = []
			try {
				snapshots = await persistence.list()
			} catch (error) {
				usageError = String((error && error.message) || error)
				seedRetryAt = Date.now() + SEED_RETRY_MS
				return
			}
			const next = new Map()
			for (const snapshot of snapshots) {
				const header = snapshot && snapshot.header
				if (!header) continue
				// A fork seed already contains its parent's prefix; counting it would double count.
				if (header.isSeeded) continue
				const view = usageViewOf(header)
				if (view) next.set(header.id, bucketsOf(view))
			}
			// A just-created session can race the listing; the live store is authoritative.
			const sessions = ctx.get('sessions')
			const projections = ctx.get('sessionProjections')
			if (sessions && projections && typeof sessions.list === 'function') {
				for (const session of sessions.list()) {
					const header = session.header
					if (!header || header.isSeeded || next.has(header.id)) continue
					try {
						const value = projections.snapshot(session, [USAGE_KEY]).values[USAGE_KEY]
						if (value) next.set(header.id, bucketsOf(value))
					} catch {
						/* skip this session */
					}
				}
			}
			perSession.clear()
			for (const [id, buckets] of next) perSession.set(id, buckets)
			recomputeTotals()
			usageError = null
			usageSeeded = true
		})().finally(() => {
			seedInflight = null
		})
		return seedInflight
	}

	/**
	 * Read the account-wide usage snapshot.
	 * @param force - rebuild from the persisted sessions before answering.
	 * @returns the usage document handed to the Client.
	 */
	const readUsage = async (force) => {
		const retryDue = Date.now() >= seedRetryAt
		if (force || (!usageSeeded && retryDue)) await seedUsage()
		const inputTokens = totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
		return {
			ready: usageSeeded && usageError === null,
			unavailable: usageError !== null,
			sessions: perSession.size,
			uncachedInputTokens: totals.uncachedInputTokens,
			outputTokens: totals.outputTokens,
			cacheReadTokens: totals.cacheReadTokens,
			cacheWriteTokens: totals.cacheWriteTokens,
			inputTokens,
			totalTokens: inputTokens + totals.outputTokens,
			updatedAt: usageUpdatedAt || Date.now(),
		}
	}

	// Live increments: the projection feed hands us each session's absolute value
	// after a committed event, so the aggregate stays O(1) per event.
	ctx.inject(['sessionProjections'], (scope) => {
		scope.effect(
			() =>
				scope.sessionProjections.onChanged((session, key, value) => {
					if (key !== USAGE_KEY) return
					const header = session && session.header
					if (!header || header.isSeeded) return
					const buckets = bucketsOf(value)
					if (buckets) setSession(header.id, buckets)
				}),
			'deepseek-account-meter live usage',
		)
	})

	// A rejected grant is already removed by the Host; drop the cached number so
	// the next read cannot keep showing money that is no longer confirmed.
	ctx.on('deepseek-account/signed-out', () => {
		balanceCache = { at: 0, value: null }
	})
	ctx.on('deepseek-account/session-expired', () => {
		balanceCache = { at: 0, value: null }
	})

	void seedUsage()

	/**
	 * Answer one summary request.
	 * @param req - the incoming request.
	 * @param res - the node response.
	 */
	const handler = async (req, res) => {
		try {
			if (!isLoopback(req)) {
				sendJson(res, 403, { ok: false, error: 'forbidden' })
				return
			}
			if (req.method !== 'GET' && req.method !== 'HEAD') {
				sendJson(res, 405, { ok: false, error: 'method not allowed' })
				return
			}
			const url = new URL(req.url || '/', 'http://127.0.0.1')
			const force = url.searchParams.get('refresh') === '1'
			const [balance, usage] = await Promise.all([readBalance(force), readUsage(force)])
			const signedIn = balance.status === 'ready' || balance.status === 'failed'
			sendJson(res, 200, { ok: true, signedIn, balance, usage })
		} catch (error) {
			sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
		}
	}

	ctx.inject(['webServer'], (scope) => {
		scope.effect(
			() => scope.webServer.register({ kind: 'exact', path: settings.path, handler: (req, res) => void handler(req, res) }),
			'deepseek-account-meter route',
		)
	})
}
