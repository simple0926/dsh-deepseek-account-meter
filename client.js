window.__ModuleLoader__.load({
	id: '@local/dsh-deepseek-account-meter',
	factory(require) {
		const React = require('react')
		const h = React.createElement
		const { useCallback, useEffect, useRef, useState } = React

		const NS = 'dsh-deepseek-account-meter'
		const ENDPOINT = '/dsh-deepseek-account-meter/summary'
		const POLL_MS = 8000

		/** Runtime dictionary; registration with the locale service is attempted in apply(). */
		const DICTS = {
			zh: {
				'balance.label': '余额',
				'balance.signedOut': '未登录',
				'usage.label': '累计',
				'usage.unit': 'tokens',
				'state.loading': '正在读取…',
				'state.unavailable': '暂无数据',
				'hint.refresh': '点击刷新',
				'hint.balance': '账户余额：%s',
				'hint.bonus': '含赠送余额：%s',
				'hint.total': '累计消耗 %s tokens（含缓存读取）',
				'hint.usage': '输入 %s · 输出 %s · 缓存读取 %s',
				'hint.sessions': '共 %s 个会话',
				'hint.updated': '更新于 %s',
			},
			en: {
				'balance.label': 'Balance',
				'balance.signedOut': 'Signed out',
				'usage.label': 'Total',
				'usage.unit': 'tokens',
				'state.loading': 'Loading…',
				'state.unavailable': 'No data',
				'hint.refresh': 'Click to refresh',
				'hint.balance': 'Account balance: %s',
				'hint.bonus': 'Includes bonus balance: %s',
				'hint.total': '%s tokens consumed (cache reads included)',
				'hint.usage': 'Input %s · Output %s · Cache read %s',
				'hint.sessions': '%s sessions',
				'hint.updated': 'Updated %s',
			},
		}

		const CSS = [
			'.dsdam-row{display:flex;align-items:center;justify-content:center;gap:10px;',
			'font-size:12px;line-height:18px;padding:1px 2px;margin:0;user-select:none;',
			'color:var(--dsw-alias-label-secondary);cursor:pointer;transition:color .15s ease;',
			'outline:none;border-radius:4px}',
			'.dsdam-row:hover{color:var(--dsw-alias-label-primary)}',
			'.dsdam-row:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary)}',
			'.dsdam-item{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}',
			'.dsdam-label{color:var(--dsw-alias-label-secondary)}',
			'.dsdam-value{color:var(--dsw-alias-label-primary);font-weight:500;',
			'font-variant-numeric:tabular-nums}',
			'.dsdam-row[data-busy="1"] .dsdam-value{opacity:.55}',
			'.dsdam-row[data-error="1"] .dsdam-value{color:var(--dsw-alias-state-warn-primary)}',
			'.dsdam-sep{width:2px;height:2px;border-radius:50%;',
			'background:var(--dsw-alias-border-l2);flex:0 0 auto}',
		].join('')

		/**
		 * Compact token count: 999, 12.3K, 1.54M, 1.52B.
		 * @param value - a token count.
		 * @returns the display text.
		 */
		function formatTokens(value) {
			const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
			if (n <= 0) return '0'
			if (n < 1000) return String(Math.round(n))
			if (n < 1000000) return scaled(n / 1000) + 'K'
			if (n < 1000000000) return scaled(n / 1000000) + 'M'
			return scaled(n / 1000000000) + 'B'
		}

		/**
		 * One decimal below 100, integer above.
		 * @param value - already-scaled count.
		 * @returns the display text.
		 */
		function scaled(value) {
			if (value < 10) return value.toFixed(2)
			if (value < 100) return value.toFixed(1)
			return String(Math.round(value))
		}

		/**
		 * Group digits for the detail tooltip.
		 * @param value - a count.
		 * @returns the grouped text.
		 */
		function formatNumber(value) {
			const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
			return Math.round(n)
				.toString()
				.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
		}

		/**
		 * Currency symbol Platform wallets use.
		 * @param currency - wallet currency code.
		 * @returns the symbol text.
		 */
		function currencySign(currency) {
			if (currency === 'USD') return '$'
			if (currency === 'CNY') return '\u00a5'
			return ''
		}

		/**
		 * Format one wallet amount the way the shipped account page does: two
		 * decimals, digit grouping, and a sub-cent marker instead of a fake zero.
		 * @param text - the decimal string Platform returns.
		 * @returns the display text without a currency symbol.
		 */
		function formatAmount(text) {
			const value = typeof text === 'number' ? text : Number(text)
			if (!Number.isFinite(value)) return String(text ?? '')
			if (value === 0) return '0.00'
			const magnitude = Math.abs(value)
			if (magnitude < 0.01) return (value > 0 ? '<' : '-') + '0.01'
			const sign = value < 0 ? '-' : ''
			const parts = magnitude.toFixed(2).split('.')
			const whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
			return sign + whole + '.' + parts[1]
		}

		/**
		 * Whether a wallet list carries a positive amount worth showing.
		 * @param wallets - platform wallet list.
		 * @returns whether any wallet is above zero.
		 */
		function hasPositive(wallets) {
			if (!Array.isArray(wallets)) return false
			return wallets.some((wallet) => Number(wallet?.balance) > 0)
		}

		/**
		 * Render wallets as `¥1.23` or `¥1.23 / $0.45`.
		 * @param wallets - platform wallet list.
		 * @returns the text, or null when empty.
		 */
		function walletsText(wallets) {
			if (!Array.isArray(wallets) || wallets.length === 0) return null
			return wallets
				.map((wallet) => currencySign(wallet?.currency) + formatAmount(wallet?.balance))
				.join(' / ')
		}

		/**
		 * Poll the Host summary endpoint for as long as the decoration is mounted.
		 * @returns the latest document plus its request state.
		 */
		function useSummary() {
			const [data, setData] = useState(null)
			const [error, setError] = useState(null)
			const [busy, setBusy] = useState(false)
			const alive = useRef(true)

			const load = useCallback(async (force) => {
				if (!alive.current) return
				setBusy(true)
				try {
					const response = await fetch(ENDPOINT + (force ? '?refresh=1' : ''), {
						headers: { accept: 'application/json' },
						cache: 'no-store',
						credentials: 'same-origin',
					})
					if (!response.ok) throw new Error('HTTP ' + response.status)
					const json = await response.json()
					if (!alive.current) return
					if (!json || json.ok === false) throw new Error((json && json.error) || 'unavailable')
					setData(json)
					setError(null)
				} catch (failure) {
					if (!alive.current) return
					setError(failure && failure.message ? failure.message : 'request failed')
				} finally {
					if (alive.current) setBusy(false)
				}
			}, [])

			useEffect(() => {
				alive.current = true
				load(false)
				const timer = setInterval(() => {
					if (document.visibilityState !== 'hidden') load(false)
				}, POLL_MS)
				const onVisibility = () => {
					if (document.visibilityState === 'visible') load(false)
				}
				document.addEventListener('visibilitychange', onVisibility)
				return () => {
					alive.current = false
					clearInterval(timer)
					document.removeEventListener('visibilitychange', onVisibility)
				}
			}, [load])

			return { data, error, busy, refresh: () => load(true) }
		}

		/**
		 * The composer-dock line: account balance and account-wide token total.
		 * @param props - slot props plus the bound translate function.
		 * @returns the rendered row.
		 */
		function Meter(props) {
			const translate = props.translate
			const { data, error, busy, refresh } = useSummary()

			const t = useCallback(
				(key, ...args) => {
					let text = ''
					try {
						text = translate ? translate(key) : ''
					} catch {
						text = ''
					}
					if (!text || text === key) text = DICTS.zh[key] || DICTS.en[key] || key
					for (const value of args) text = text.replace('%s', value)
					return text
				},
				[translate],
			)

			if (data === null) {
				const placeholder = error ? t('state.unavailable') : t('state.loading')
				return h(
					'div',
					{
						className: 'dsdam-row',
						'data-error': error ? '1' : '0',
						role: 'status',
						title: error || t('state.loading'),
					},
					h('style', { key: 'style' }, CSS),
					h('span', { className: 'dsdam-item', key: 'loading' },
						h('span', { className: 'dsdam-label' }, t('balance.label')),
						h('span', { className: 'dsdam-value' }, placeholder),
					),
				)
			}

			const balance = data.balance || {}
			const usage = data.usage || {}
			const balanceStatus = balance.status || 'unavailable'
			const balanceReady = balanceStatus === 'ready'
			const balanceText = balanceReady ? walletsText(balance.wallets) : null
			const bonusText = balanceReady && hasPositive(balance.bonusWallets) ? walletsText(balance.bonusWallets) : null
			const usageReady = usage.ready === true

			const balanceValue = balanceReady
				? balanceText || bonusText || '\u00a50.00'
				: balanceStatus === 'signed-out'
					? t('balance.signedOut')
					: t('state.unavailable')
			const usageValue = usageReady ? formatTokens(usage.totalTokens) : t('state.unavailable')

			const titleParts = [t('hint.refresh')]
			if (balanceReady && balanceText) {
				titleParts.push(t('hint.balance', balanceText))
				if (bonusText) titleParts.push(t('hint.bonus', bonusText))
			}
			if (usageReady) {
				titleParts.push(t('hint.total', formatNumber(usage.totalTokens)))
				titleParts.push(t('hint.usage', formatNumber(usage.inputTokens), formatNumber(usage.outputTokens), formatNumber(usage.cacheReadTokens)))
				if (usage.sessions !== undefined) titleParts.push(t('hint.sessions', formatNumber(usage.sessions)))
			}
			if (usage.updatedAt) {
				let clock = ''
				try {
					clock = new Date(usage.updatedAt).toLocaleTimeString()
				} catch {
					clock = ''
				}
				if (clock) titleParts.push(t('hint.updated', clock))
			}

			return h(
				'div',
				{
					className: 'dsdam-row',
					'data-busy': busy ? '1' : '0',
					'data-error': error ? '1' : '0',
					title: titleParts.join('\n'),
					role: 'button',
					tabIndex: 0,
					onClick: refresh,
					onKeyDown: (event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault()
							refresh()
						}
					},
				},
				h('style', { key: 'style' }, CSS),
				h('span', { className: 'dsdam-item', key: 'balance' },
					h('span', { className: 'dsdam-label' }, t('balance.label')),
					h('span', { className: 'dsdam-value' }, balanceValue),
				),
				h('span', { className: 'dsdam-sep', key: 'sep', 'aria-hidden': true }),
				h('span', { className: 'dsdam-item', key: 'usage' },
					h('span', { className: 'dsdam-label' }, t('usage.label')),
					h('span', { className: 'dsdam-value' }, usageValue),
					h('span', { className: 'dsdam-label' }, t('usage.unit')),
				),
			)
		}

		return {
			inject: ['slots'],
			apply(ctx) {
				const locale = ctx.get('locale')
				if (locale && typeof locale.register === 'function') {
					ctx.effect(() => {
						const disposers = []
						for (const id of ['zh', 'en']) {
							try {
								disposers.push(locale.register(NS, id, DICTS[id]))
							} catch {
								/* An already-registered locale is not fatal. */
							}
						}
						return () => {
							for (const dispose of disposers) {
								try {
									dispose()
								} catch {
									/* ignore */
								}
							}
						}
					}, 'deepseek-account-meter locale')
				}

				let translate = null
				if (locale && typeof locale.bind === 'function') {
					try {
						translate = locale.bind(NS)
					} catch {
						translate = null
					}
				}

				ctx.slots.inject('conversation.composer.dock', () =>
					ctx.slots.register(
						{
							name: 'conversation.composer.dock',
							id: 'deepseek-account-meter',
							order: 2,
							label: 'DeepSeek account meter',
						},
						(props) => h(Meter, { ...props, translate }),
					),
				)
			},
		}
	},
})
