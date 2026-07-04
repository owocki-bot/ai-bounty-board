/**
 * Bounty board analytics API for dashboards.
 *
 * Read-only aggregates over the existing bounty store: completion rates by
 * week, time-to-complete, top builders by earnings, reward distribution by
 * category, trend data, and a summary snapshot. All computation lives in
 * ./analytics.js as pure functions (no I/O), so it's unit-testable and easy
 * to reuse elsewhere (e.g. a future /mod dashboard).
 *
 * Mounted the same way browse-handler.js is: registerAnalyticsHandler(app, getAllBounties)
 */
const {
  completionRatesByWeek,
  timeToComplete,
  topBuilders,
  rewardsByCategory,
  trends,
  summary,
} = require('./analytics');

function registerAnalyticsHandler(app, getAllBounties) {

  const DOCS = {
    name: 'Bounty Board Analytics API',
    description:
      'Read-only analytics over this bounty board: completion rates, time-to-complete, ' +
      'top earners, reward distribution by category, and trend data. Meant to be dropped ' +
      'straight into a dashboard.',
    endpoints: [
      { path: '/api/analytics/summary', description: 'Total bounties, completion rate, USDC paid, unique builders.' },
      { path: '/api/analytics/completion-rates?weeks=12', description: 'Completion rate per ISO week, bucketed by creation week.' },
      { path: '/api/analytics/time-to-complete', description: 'Avg/median hours claim→complete and creation→complete, by tag.' },
      { path: '/api/analytics/top-builders?limit=10', description: 'Builders ranked by net USDC earned.' },
      { path: '/api/analytics/rewards-by-category', description: 'USDC totals grouped by tag.' },
      { path: '/api/analytics/trends?days=30', description: 'Daily time series: bounties created/completed, USDC paid.' },
    ],
    notes: [
      'All monetary figures are USDC.',
      'Only bounties with status "completed" count toward earnings, completion numerators, and time-to-complete.',
      'A bounty with multiple tags counts toward each tag in rewards-by-category, so category totals can exceed the platform total.',
    ],
  };

  app.get('/api/analytics', (req, res) => res.json(DOCS));

  app.get('/api/analytics/summary', async (req, res) => {
    const bounties = await getAllBounties();
    res.json(summary(bounties));
  });

  app.get('/api/analytics/completion-rates', async (req, res) => {
    const weeks = Number(req.query.weeks) || 12;
    const bounties = await getAllBounties();
    res.json({ weeks, data: completionRatesByWeek(bounties, { weeks }) });
  });

  app.get('/api/analytics/time-to-complete', async (req, res) => {
    const bounties = await getAllBounties();
    res.json(timeToComplete(bounties));
  });

  app.get('/api/analytics/top-builders', async (req, res) => {
    const limit = Number(req.query.limit) || 10;
    const bounties = await getAllBounties();
    res.json({ limit, data: topBuilders(bounties, { limit }) });
  });

  app.get('/api/analytics/rewards-by-category', async (req, res) => {
    const bounties = await getAllBounties();
    res.json({ data: rewardsByCategory(bounties) });
  });

  app.get('/api/analytics/trends', async (req, res) => {
    const days = Number(req.query.days) || 30;
    const bounties = await getAllBounties();
    res.json({ days, data: trends(bounties, { days }) });
  });
}

module.exports = registerAnalyticsHandler;
