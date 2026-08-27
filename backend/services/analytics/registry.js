// The catalogue of every analysis the two intelligence pages compute.
//
// This is documentation that cannot drift: the Catalogue tab renders straight
// from this list, and each entry names the module and payload key that actually
// produces it. If a metric is removed from a module its entry here becomes
// obviously stale, and the `status` field is the honest record of which ones
// depend on data the deployment may not have yet.
//
// status:
//   'live'        computed from data every deployment has
//   'conditional' computed, but returns an explicit "no data" state until the
//                 named prerequisite has accumulated (see `requires`)
//
// Fields are deliberately short. The UI groups by page/tab and filters on
// domain, status and the free-text definition.

const PAGES = Object.freeze({
  FIRM: 'firm-intelligence',
  TRADER: 'trader-risk-intelligence'
})

function m (id, name, tab, definition, tables, extra = {}) {
  return {
    id,
    name,
    page: extra.page || (id.startsWith('D') || id.startsWith('G') || id.startsWith('H') || id.startsWith('I') || id.startsWith('J') ? PAGES.TRADER : PAGES.FIRM),
    tab,
    definition,
    tables,
    status: extra.requires ? 'conditional' : 'live',
    requires: extra.requires || null,
    payload_key: extra.key || null
  }
}

const METRICS = [
  // ── A. Revenue & unit economics ────────────────────────────────────────────
  m('A1', 'Gross revenue over time', 'revenue', 'Paid challenge-order value per day, split by payment provider.', ['revenue_daily', 'challenge_orders'], { key: 'series' }),
  m('A2', 'Net revenue', 'revenue', 'Gross revenue less affiliate commission and trader payouts settled in the window.', ['revenue_daily'], { key: 'series.totals' }),
  m('A3', 'ARPU / ARPA by cohort', 'revenue', 'Lifetime revenue per user and per account, grouped by signup month.', ['users', 'challenge_orders', 'accounts'], { key: 'cohort_arpu' }),
  m('A4', 'Revenue by account size', 'revenue', 'Paid order value and average realised price per account-size tier.', ['challenge_orders'], { key: 'cuts.by_account_size' }),
  m('A5', 'Revenue by model', 'revenue', 'Paid order value per challenge model and step count.', ['challenge_orders', 'challenge_models'], { key: 'cuts.by_model' }),
  m('A6', 'Checkout conversion', 'revenue', 'Orders created → orders with a provider session → orders paid.', ['challenge_orders', 'challenge_checkout_sessions'], { key: 'checkout' }),
  m('A7', 'Time to pay', 'revenue', 'Median minutes from order creation to payment, plus the fast and stale tails.', ['challenge_orders'], { key: 'checkout.time_to_pay_mins' }),
  m('A8', 'Payment provider quality', 'revenue', 'Attempts, success rate, captured value, platform fees and settle latency per provider.', ['challenge_payments'], { key: 'checkout.providers' }),
  m('A9', 'Coupon performance', 'revenue', 'Redemptions, discount given and revenue accompanying each code.', ['coupon_redemptions', 'coupon_codes'], { key: 'coupons.per_code' }),
  m('A10', 'Coupon cannibalisation', 'revenue', 'Share of paid orders and revenue sold at a discount versus full price.', ['challenge_orders', 'coupon_redemptions'], { key: 'coupons.cannibalisation' }),
  m('A11', 'Gift voucher funnel', 'revenue', 'Issued, claimed, expired and revoked vouchers with time-to-claim.', ['gift_vouchers'], { key: 'gifts' }),
  m('A12', 'Repeat purchase rate', 'revenue', 'Share of buyers with more than one paid order, and the orders-per-buyer histogram.', ['challenge_orders'], { key: 'buyers' }),
  m('A13', 'Retry economics', 'revenue', 'Failed accounts followed by another paid order, and free retries consumed.', ['accounts', 'challenge_orders'], { key: 'retries' }),
  m('A14', 'Cohort LTV', 'revenue', 'Revenue less payouts and affiliate commission, per signup-month cohort.', ['users', 'challenge_orders', 'payouts', 'affiliate_commissions'], { key: 'lifetime_value' }),
  m('A15', 'LTV:CAC', 'revenue', 'Cohort contribution per user against acquisition spend for that month.', ['marketing_spend', 'users'], { requires: 'rows in marketing_spend', key: 'lifetime_value' }),
  m('A16', 'Payback period', 'revenue', 'Months for a cohort to recoup its acquisition cost at its own contribution rate.', ['marketing_spend', 'users'], { requires: 'rows in marketing_spend', key: 'lifetime_value' }),
  m('A17', 'Gross margin per model', 'revenue', 'Model revenue less payouts settled against that model.', ['challenge_orders', 'payouts', 'accounts'], { key: 'model_margin' }),
  m('A18', 'B-book edge', 'revenue', 'Trader demo P&L against broker P&L, daily and per instrument.', ['trade_daily_stats'], { key: 'bbook' }),
  m('A19', 'Revenue concentration', 'revenue', 'Share of revenue from the top 1%, 5% and 10% of buyers.', ['challenge_orders'], { key: 'buyers.concentration' }),
  m('A20', 'Refunds and chargebacks', 'revenue', 'Every non-succeeded payment status with value, flagging the refund-shaped ones.', ['challenge_payments'], { key: 'refunds' }),
  m('A21', 'Deferred revenue', 'revenue', 'Paid orders with no account started, plus notional on in-progress evaluations.', ['challenge_orders', 'accounts'], { key: 'deferred' }),
  m('A22', 'New vs returning revenue', 'revenue', 'Daily split of buyers making a first purchase versus a repeat one.', ['revenue_daily'], { key: 'series.totals' }),
  m('A23', 'Revenue by country', 'revenue', 'Paid order value per buyer country and currency.', ['challenge_orders', 'users'], { key: 'cuts.by_country' }),
  m('A24', 'Discount depth', 'revenue', 'Average realised price against the active list price for the same model and size.', ['challenge_orders', 'challenge_model_pricing'], { key: 'coupons.discount_depth' }),
  m('A25', 'Break-even payouts', 'revenue', 'Payouts of the observed average size a model\'s sales can absorb before margin hits zero.', ['challenge_orders', 'payouts'], { key: 'model_margin' }),

  // ── B. Model & pricing optimisation ────────────────────────────────────────
  m('B26', 'Pass rate by model and phase', 'models', 'Passed over resolved accounts, per model per phase.', ['accounts'], { key: 'pass_rates' }),
  m('B27', 'Fail-cause decomposition', 'models', 'One cause per failed account in fixed precedence, so buckets sum to the failure count.', ['accounts', 'admin_rule_violations'], { key: 'fail_causes' }),
  m('B28', 'Days to pass and fail', 'models', 'Median days from phase start to outcome, per model and phase.', ['accounts'], { key: 'time_to_outcome' }),
  m('B29', 'Survival curve', 'models', 'Share of a model\'s accounts still un-failed at day 1 through 90.', ['accounts'], { key: 'survival' }),
  m('B30', 'Daily drawdown sensitivity', 'models', 'Counterfactual breach counts if the daily limit moved one point either way.', ['daily_pnl_records', 'accounts', 'challenge_models'], { key: 'rule_sensitivity' }),
  m('B31', 'Consistency-rule bind rate', 'models', 'Accounts that reached target but had one day exceeding the consistency cap.', ['accounts', 'daily_pnl_records'], { key: 'bind_rates' }),
  m('B32', 'Min-trading-days bind rate', 'models', 'Accounts that reached target while short of the qualifying-day requirement.', ['accounts'], { key: 'bind_rates' }),
  m('B33', 'Time-limit bind rate', 'models', 'Accounts that expired while still in profit.', ['accounts'], { key: 'bind_rates' }),
  m('B34', 'Difficulty versus price', 'models', 'Composite rule-matrix difficulty score against average active price and observed pass rate.', ['challenge_models', 'challenge_model_pricing', 'accounts'], { key: 'difficulty' }),
  m('B35', 'Phase waterfall', 'models', 'Phase 1 → phase 2 → funded conversion across the whole book.', ['accounts'], { key: 'pass_rates.waterfall' }),
  m('B36', 'Funded lifecycle', 'models', 'Funded survival, payout conversion and days to first payout per model.', ['accounts', 'payouts'], { key: 'funded_lifecycle' }),
  m('B37', 'Expected value per sale', 'models', 'Average fee less pass probability times average realised payout.', ['challenge_orders', 'accounts', 'payouts'], { key: 'expected_value' }),
  m('B38', 'Scaling uptake', 'models', 'Funded accounts claiming milestones, average multiplier and added notional.', ['accounts'], { key: 'scaling' }),
  m('B39', 'Free-retry impact', 'models', 'Pass rate of accounts with a retry remaining versus those that have used it.', ['accounts'], { key: 'retry_impact' }),
  m('B40', 'Rule-change impact on outcomes', 'models', 'Account volume and pass rate 14 days either side of each settings change.', ['settings_change_log', 'accounts'], { key: 'rule_changes' }),

  // ── C. Payout & liability ──────────────────────────────────────────────────
  m('C41', 'Liability forecast', 'liability', 'Unrealised funded profit times each account\'s configured profit split.', ['accounts', 'challenge_models', 'payouts'], { key: 'forecast' }),
  m('C42', 'Payout pipeline and aging', 'liability', 'Requests by status, open-queue age buckets and observed turnaround.', ['payouts'], { key: 'pipeline' }),
  m('C43', 'Approval and rejection mix', 'liability', 'Share of decided payouts rejected.', ['payouts'], { key: 'pipeline.decisions' }),
  m('C44', 'Payout size distribution', 'liability', 'Mean, median, p90 and largest settled payout, and the split by account size.', ['payouts', 'accounts'], { key: 'distribution' }),
  m('C45', 'Time to first payout', 'liability', 'Days from funded-account creation to first settled payout.', ['payouts', 'accounts'], { key: 'cadence' }),
  m('C46', 'Repeat payout rate', 'liability', 'Share of paying accounts that withdrew more than once.', ['payouts'], { key: 'cadence' }),
  m('C47', 'Payout concentration', 'liability', 'Share of all payout value going to the top 1%, 5% and 10% of traders.', ['payouts', 'users'], { key: 'distribution.concentration' }),
  m('C48', 'Profit-split leakage', 'liability', 'Realised trader share against the split the model configures.', ['payouts', 'accounts', 'challenge_models'], { key: 'split_leakage' }),
  m('C49', 'Flagged payouts', 'liability', 'Flag rate, reason mix and how often a flag was upheld at decision.', ['payouts'], { key: 'flagged' }),
  m('C50', 'Payout-to-revenue ratio', 'liability', 'Settled payouts as a share of gross revenue, rolling 30 and 90 days.', ['revenue_daily'], { key: 'payout_to_revenue' }),
  m('C51', 'Payment method mix', 'liability', 'Requests, success rate and turnaround per withdrawal method.', ['payouts'], { key: 'payment_methods' }),
  m('C52', 'Liability stress test', 'liability', 'Owed amount if 5–35% of active evaluations passed and withdrew at observed average size.', ['accounts', 'payouts', 'revenue_daily'], { key: 'stress' }),

  // ── D. Risk, fraud & compliance ────────────────────────────────────────────
  m('D53', 'Violation heatmap', 'risk', 'Violations by type, severity and challenge model.', ['admin_rule_violations', 'accounts'], { key: 'heatmap' }),
  m('D54', 'Repeat offenders', 'risk', 'Traders with multiple violations, ranked by severity and hit escalation.', ['admin_rule_violations', 'users'], { key: 'repeat_offenders' }),
  m('D55', 'Violation resolution time', 'risk', 'Hours to resolve by type and resolution, plus the open backlog age.', ['admin_rule_violations'], { key: 'resolution' }),
  m('D56', 'Drawdown proximity', 'risk', 'Live accounts by share of drawdown allowance already consumed.', ['accounts', 'trades'], { key: 'drawdown.at_risk' }),
  m('D57', 'Breach prediction', 'risk', 'Projected days to the drawdown floor at the account\'s own five-day burn rate.', ['accounts', 'daily_pnl_records', 'trades'], { key: 'drawdown.predicted_breach' }),
  m('D58', 'Copy-trading pairs', 'risk', 'Account pairs repeatedly opening the same instrument and direction within seconds.', ['trades', 'accounts'], { key: 'copy_trading' }),
  m('D59', 'Simultaneous-open clustering', 'risk', 'Paired-trade count as a share of each account\'s own activity.', ['trades'], { key: 'copy_trading.pairs' }),
  m('D60', 'Latency and stale-price abuse', 'risk', 'Entries repeatedly more than 0.1% away from the last recorded feed tick.', ['trades', 'price_feed_history'], { key: 'latency_abuse' }),
  m('D61', 'Slippage outliers', 'risk', 'Per-account average slippage z-scored against the platform distribution.', ['trades'], { key: 'slippage' }),
  m('D62', 'News-window trading', 'risk', 'Trades opened inside the restricted window around high-impact events.', ['trades', 'news_cache'], { key: 'news_window' }),
  m('D63', 'Martingale detection', 'risk', 'Position size escalating sharply straight after a loss, repeatedly.', ['trades'], { key: 'strategies.martingale' }),
  m('D64', 'Grid detection', 'risk', 'Many concurrent open positions on one instrument from one account.', ['trades'], { key: 'strategies.grid' }),
  m('D65', 'Hedging detection', 'risk', 'Opposing positions held simultaneously on the same instrument.', ['trades'], { key: 'strategies.hedging' }),
  m('D66', 'Bot and EA likelihood', 'risk', 'Machine-regular trade spacing combined with invariant lot sizing.', ['trades', 'accounts'], { key: 'bots' }),
  m('D67', 'Tick scalping', 'risk', 'Accounts closing a high share of trades inside a minute.', ['trades'], { key: 'strategies.scalping' }),
  m('D68', 'Shared IP graph', 'risk', 'IP addresses seen for more than one user across logins and trades.', ['login_logs', 'trade_logs'], { key: 'identity.shared_ips' }),
  m('D69', 'Shared devices and documents', 'risk', 'Device fingerprints and KYC document hashes reused across users.', ['users'], { key: 'identity.shared_devices' }),
  m('D70', 'Shared payout destinations', 'risk', 'Identical withdrawal details used by more than one trader.', ['payouts'], { key: 'identity.shared_payment_details' }),
  m('D71', 'Link-cluster risk', 'risk', 'Account-linking clusters by score and confidence, and their growth over time.', ['account_link_clusters'], { key: 'link_clusters' }),
  m('D72', 'Payout fraud score', 'risk', 'Per-request risk score with every contributing factor listed beside it.', ['payouts', 'users', 'accounts', 'admin_rule_violations', 'account_link_clusters', 'login_logs'], { key: 'payout_fraud' }),
  m('D73', 'AML velocity', 'risk', 'Purchase-to-payout speed against how little trading happened in between.', ['payouts', 'challenge_orders', 'accounts', 'trades'], { key: 'aml' }),
  m('D74', 'KYC funnel', 'risk', 'Status mix, pending age and rejection reasons.', ['users'], { key: 'kyc' }),
  m('D75', 'Geographic mismatch', 'risk', 'Users logging in from more than one country in 90 days.', ['login_logs', 'users'], { requires: 'login_logs.country populated by an edge country header', key: 'geo' }),
  m('D76', 'Admin action analytics', 'risk', 'Actions per admin, action mix, four-eyes usage and enforcement outcomes.', ['admin_immutable_audit', 'admin_four_eyes_requests', 'admin_enforcement_events'], { key: 'admin_actions' }),
  m('D77', 'Rule-change impact on violations', 'risk', 'Violation volume 14 days either side of each settings change.', ['settings_change_log', 'admin_rule_violations'], { key: 'rule_change_impact' }),

  // ── E. Growth, funnel, affiliate & retention ───────────────────────────────
  m('E78', 'Acquisition funnel', 'growth', 'Visit → pricing → checkout → register → order → paid.', ['marketing_funnel_events', 'users', 'challenge_orders'], { key: 'funnel.stages' }),
  m('E79', 'Conversion by source', 'growth', 'First-touch UTM source through to signups, buyers and revenue.', ['marketing_funnel_events', 'challenge_orders'], { requires: 'UTM-tagged traffic (migration 040)', key: 'funnel.by_source' }),
  m('E80', 'Activation', 'growth', 'Share of signups placing a first trade, and how long it took.', ['users', 'trades', 'accounts'], { key: 'activation' }),
  m('E81', 'A/B experiment readouts', 'growth', 'Per-variant conversion with a two-proportion test against the control.', ['ab_experiments', 'ab_experiment_events'], { key: 'experiments' }),
  m('E82', 'Cohort retention', 'growth', 'Share of each signup week still trading at weeks 1, 2–3 and 4+.', ['users', 'trades', 'accounts'], { key: 'retention.cohorts' }),
  m('E83', 'Dormancy', 'growth', 'Active accounts with no trade in 7, 14 or 30 days.', ['accounts', 'trades'], { key: 'retention.dormancy' }),
  m('E84', 'Reactivation', 'growth', 'Buyers lapsed over 45 days who purchased again in the window.', ['challenge_orders'], { key: 'retention.reactivation' }),
  m('E85', 'Affiliate leaderboard', 'growth', 'Referrals, paying conversions, revenue and revenue per commission dollar.', ['affiliate_referrals', 'affiliate_commissions', 'challenge_orders'], { key: 'affiliates.leaderboard' }),
  m('E86', 'Referred versus organic quality', 'growth', 'Pass rate and payout cost of referred traders against everyone else.', ['accounts', 'affiliate_referrals', 'payouts'], { key: 'affiliates.quality' }),
  m('E87', 'Self-referral detection', 'growth', 'Referrer and referee appearing in the same account-link cluster.', ['affiliate_referrals', 'account_link_clusters'], { key: 'affiliates.self_referral_suspects' }),
  m('E88', 'Commission liability and tiers', 'growth', 'Commission by state and by tier rank.', ['affiliate_commissions'], { key: 'affiliates.commission_state' }),
  m('E89', 'Referral season performance', 'growth', 'Entrants, paying referrals and prize vouchers per season.', ['referral_seasons', 'referral_season_entries', 'referral_season_prize_vouchers'], { key: 'referral_seasons' }),
  m('E90', 'Competition participation', 'growth', 'Entries, completion and disqualification rates per competition.', ['competitions', 'competition_entries'], { key: 'competitions' }),
  m('E91', 'Competition return', 'growth', 'Participants who bought a challenge within 30 days of the competition ending.', ['competitions', 'competition_entries', 'challenge_orders'], { key: 'competitions' }),
  m('E92', 'Geographic performance', 'growth', 'Signups, conversion, revenue and pass rate per country.', ['users', 'challenge_orders', 'accounts'], { key: 'geography' }),
  m('E93', 'Email delivery', 'growth', 'Jobs, delivery rate and retry load per template.', ['email_jobs'], { key: 'email' }),
  m('E94', 'Public page engagement', 'growth', 'Sessions reaching the leaderboard, transparency and pricing pages.', ['marketing_funnel_events'], { requires: 'the richer event types added in migration 040', key: 'public_pages' }),
  m('E95', 'Signup-to-revenue lag', 'growth', 'Distribution of days from registration to first paid order.', ['users', 'challenge_orders'], { key: 'activation.lag_histogram' }),

  // ── F. Ops & platform health ───────────────────────────────────────────────
  m('F96', 'Support load and SLA', 'ops', 'Ticket volume by category with first-response, resolution and SLA breaches.', ['support_tickets', 'support_ticket_messages'], { key: 'support' }),
  m('F97', 'Dispute rate and cost', 'ops', 'Disputes per 100 account failures, with status mix and time open.', ['disputes', 'accounts'], { key: 'disputes' }),
  m('F98', 'Ticket themes by account state', 'ops', 'Which ticket categories come from failed, funded, payout-waiting or KYC-pending traders.', ['support_tickets', 'accounts', 'payouts', 'users'], { key: 'ticket_context' }),
  m('F99', 'Price feed health', 'ops', 'Per-instrument staleness, source status and cross-source divergence.', ['price_feed', 'price_feed_sources', 'price_feed_source_history_1h'], { key: 'price_feed' }),
  m('F100', 'Engine health', 'ops', 'Email backlog, system-closed trade share, stale open positions and idempotency claims.', ['email_jobs', 'trades', 'idempotency_requests'], { key: 'engine' }),

  // ── G. Trader performance & edge ───────────────────────────────────────────
  m('G101', 'Equity curve', 'edge', 'Cumulative equity by closed trade with running drawdown.', ['trades', 'accounts'], { key: 'equity_curve' }),
  m('G102', 'Profit factor and expectancy', 'edge', 'Gross win over gross loss, and average P&L per closed trade.', ['trades'], { key: 'edge' }),
  m('G103', 'Win rate breakdowns', 'edge', 'Performance split by instrument, direction, session, weekday and hour.', ['trades'], { key: 'breakdowns' }),
  m('G104', 'R-multiple distribution', 'edge', 'Risk-normalised outcome buckets for trades with a stop loss.', ['trades'], { key: 'edge.r_multiple' }),
  m('G105', 'Strategy expectancy', 'edge', 'Expectancy per strategy tag and per setup.', ['trades'], { key: 'breakdowns.strategy' }),
  m('G106', 'Maximum adverse excursion', 'edge', 'Worst price reached against the position while it was open.', ['trades', 'price_feed_history'], { requires: 'closed trades inside the 90-day price-history retention', key: 'excursions' }),
  m('G107', 'Trade efficiency', 'edge', 'Captured move as a share of the best move available while open.', ['trades', 'price_feed_history'], { requires: 'closed trades inside the 90-day price-history retention', key: 'excursions' }),
  m('G108', 'Exit quality', 'edge', 'P&L left on the table after the close, per trade and in total.', ['trades', 'price_feed_history'], { requires: 'closed trades inside the 90-day price-history retention', key: 'excursions.worst_exits' }),
  m('G109', 'Entry timing', 'edge', 'Adverse excursion taken on before the trade worked.', ['trades', 'price_feed_history'], { requires: 'closed trades inside the 90-day price-history retention', key: 'excursions' }),
  m('G110', 'Hold time versus outcome', 'edge', 'Duration quartiles for winners against losers.', ['trades'], { key: 'hold_time' }),
  m('G111', 'Streaks', 'edge', 'Longest win and loss runs.', ['trades'], { key: 'behaviour.streaks' }),
  m('G112', 'Rolling 30-trade edge', 'edge', 'Win rate and expectancy over a moving 30-trade window.', ['trades'], { key: 'edge.rolling_30' }),
  m('G113', 'Sharpe, Sortino, Calmar', 'edge', 'Risk-adjusted ratios on daily realised P&L, unannualised.', ['account_daily_stats'], { key: 'risk_adjusted' }),
  m('G114', 'Ulcer index and recovery factor', 'edge', 'Depth-and-duration drawdown measure and return over max drawdown.', ['account_daily_stats'], { key: 'risk_adjusted' }),
  m('G115', 'Outlier dependence', 'edge', 'Whether the result survives removing the best 5% of trades.', ['trades'], { key: 'edge.outlier_dependence' }),
  m('G116', 'Concentration and concurrency', 'edge', 'Instrument Herfindahl index and peak simultaneous positions.', ['trades'], { key: 'concentration' }),
  m('G117', 'Long versus short edge', 'edge', 'Trade count, win rate and net P&L by direction.', ['trades'], { key: 'edge.direction' }),
  m('G118', 'Cost drag', 'edge', 'Commission as a share of gross result.', ['trades'], { key: 'edge.cost_drag' }),
  m('G119', 'Partial-close effectiveness', 'edge', 'Average P&L of scaled-out trades against all-in closes.', ['trades'], { key: 'execution.partials' }),
  m('G120', 'Order type quality', 'edge', 'Fill and cancellation rates by order type.', ['trades'], { key: 'execution.order_types' }),

  // ── H. Trader risk & discipline ────────────────────────────────────────────
  m('H121', 'Discipline score', 'discipline', 'Composite of overtrading, revenge sequences and impulsive exits, with components.', ['trades', 'admin_rule_violations'], { key: 'discipline' }),
  m('H122', 'Risk consistency', 'discipline', 'Coefficient of variation on lot size and planned risk, plus stop-loss usage.', ['trades'], { key: 'risk_consistency' }),
  m('H123', 'Stop and target usage', 'discipline', 'Share of trades carrying a stop loss and a take profit.', ['trades'], { key: 'behaviour.protection' }),
  m('H124', 'Revenge trading', 'discipline', 'Oversized positions opened within minutes of a loss, and what they cost.', ['trades'], { key: 'behaviour.revenge_trading' }),
  m('H125', 'Overtrading days', 'discipline', 'Days above the trade-count threshold and the P&L on them.', ['trades'], { key: 'behaviour.overtrading' }),
  m('H126', 'Quick exits', 'discipline', 'Share of trades closed inside five minutes.', ['trades'], { key: 'behaviour.quick_exits' }),
  m('H127', 'Daily limit proximity', 'discipline', 'How much of each day\'s loss allowance was consumed, day by day.', ['daily_pnl_records', 'accounts'], { key: 'risk_behaviour.daily_risk' }),
  m('H128', 'Consistency exposure', 'discipline', 'Best day as a share of total profit against the account\'s cap.', ['daily_pnl_records', 'accounts'], { key: 'risk_behaviour.consistency' }),
  m('H129', 'Overnight and weekend exposure', 'discipline', 'Share of trades held across a day boundary or opened at the weekend.', ['trades'], { key: 'risk_behaviour.overnight' }),
  m('H130', 'Leverage utilisation', 'discipline', 'Notional against account size, relative to the model\'s maximum.', ['trades', 'accounts', 'challenge_models'], { key: 'risk_behaviour.leverage' }),
  m('H131', 'Behaviour after a warning', 'discipline', 'Lot size, win rate and average P&L before and after the first violation.', ['trades', 'admin_rule_violations'], { key: 'risk_behaviour.behaviour_change' }),
  m('H132', 'Risk of ruin', 'discipline', 'Gambler\'s-ruin estimate from the trader\'s own win rate, payoff and remaining drawdown.', ['trades', 'accounts'], { key: 'risk_behaviour.risk_of_ruin' }),

  // ── I. Challenge progress & forecasting ────────────────────────────────────
  m('I133', 'Target progress and pace', 'forecast', 'Profit against target, with projected days to target at the current rate.', ['accounts', 'daily_pnl_records'], { key: 'forecast.target' }),
  m('I134', 'Pass probability', 'forecast', 'Empirical pass rate of comparable historical accounts at the same progress.', ['accounts'], { key: 'forecast.pass_probability' }),
  m('I135', 'Required daily P&L', 'forecast', 'Profit per remaining day needed to reach target inside the time limit.', ['accounts'], { key: 'forecast.time' }),
  m('I136', 'Qualifying days', 'forecast', 'Qualifying days achieved against the model minimum.', ['accounts', 'daily_pnl_records'], { key: 'forecast.qualifying_days' }),
  m('I137', 'Consistency headroom', 'forecast', 'Largest single day still allowed under the consistency cap.', ['accounts', 'daily_pnl_records'], { key: 'forecast.consistency_headroom' }),
  m('I138', 'Drawdown headroom', 'forecast', 'Distance to the floor in currency and in average losing trades.', ['accounts', 'trades'], { key: 'forecast.drawdown_headroom' }),
  m('I139', 'Payout readiness', 'forecast', 'Blockers between this account and a payable withdrawal.', ['accounts', 'payouts', 'users'], { key: 'forecast' }),
  m('I140', 'Scaling tracker', 'forecast', 'Milestones claimed, current multiplier and the next tier\'s requirement.', ['accounts', 'challenge_models'], { key: 'forecast.scaling' }),
  m('I141', 'Pace against passers', 'forecast', 'Days used against the median passing account on the same model.', ['accounts'], { key: 'forecast.time' }),
  m('I142', 'What-if projection', 'forecast', 'Equity after the next 10, 25 and 50 trades at current expectancy.', ['trades', 'accounts'], { key: 'forecast.what_if' }),

  // ── J. Benchmarking & reporting ────────────────────────────────────────────
  m('J143', 'Percentile rank', 'benchmark', 'Net P&L rank against accounts on the same model and size.', ['accounts', 'trades'], { key: 'benchmarks.percentile_rank' }),
  m('J144', 'Peer comparison', 'benchmark', 'Win rate, profit factor and net P&L against the peer average.', ['accounts', 'trades'], { key: 'benchmarks.comparison' }),
  m('J145', 'Passer comparison', 'benchmark', 'The same metrics against accounts that actually passed.', ['accounts', 'trades'], { key: 'benchmarks.comparison' }),
  m('J146', 'Session and instrument edge versus platform', 'benchmark', 'Where this trader beats or trails the platform average.', ['trades', 'trade_daily_stats'], { key: 'breakdowns' }),
  m('J147', 'Performance report export', 'benchmark', 'Every table on the page exports to CSV for record-keeping.', ['trades', 'accounts'], { key: null }),
  m('J148', 'Setup report', 'benchmark', 'Best and worst setups across instrument, session and strategy.', ['trades'], { key: 'setups' }),
  m('J149', 'Journal insight', 'benchmark', 'Outcome of journalled versus unjournalled trades, and performance by tag.', ['trades'], { key: 'journal' }),
  m('J150', 'Milestones and certificates', 'benchmark', 'Account, pass and certificate history as one timeline.', ['certificates', 'accounts'], { key: 'milestones' })
]

const TABS = Object.freeze({
  revenue: { page: PAGES.FIRM, label: 'Revenue & Economics' },
  models: { page: PAGES.FIRM, label: 'Models & Pricing' },
  liability: { page: PAGES.FIRM, label: 'Payouts & Liability' },
  growth: { page: PAGES.FIRM, label: 'Growth & Affiliate' },
  ops: { page: PAGES.FIRM, label: 'Ops Health' },
  pulse: { page: PAGES.FIRM, label: 'Live Pulse' },
  catalogue: { page: PAGES.FIRM, label: 'Catalogue' },
  risk: { page: PAGES.TRADER, label: 'Risk & Fraud' },
  edge: { page: PAGES.TRADER, label: 'Edge' },
  discipline: { page: PAGES.TRADER, label: 'Discipline' },
  forecast: { page: PAGES.TRADER, label: 'Forecast' },
  benchmark: { page: PAGES.TRADER, label: 'Benchmark' }
})

function summary () {
  const byTab = new Map()
  for (const metric of METRICS) {
    const entry = byTab.get(metric.tab) || { tab: metric.tab, page: metric.page, label: TABS[metric.tab]?.label || metric.tab, metrics: 0, conditional: 0 }
    entry.metrics += 1
    if (metric.status === 'conditional') entry.conditional += 1
    byTab.set(metric.tab, entry)
  }
  return {
    total: METRICS.length,
    conditional: METRICS.filter((x) => x.status === 'conditional').length,
    tabs: [...byTab.values()]
  }
}

module.exports = { METRICS, TABS, PAGES, summary }
