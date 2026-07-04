// analytics.js
// Pure functions that turn raw bounty.owockibot.xyz/bounties records into
// dashboard-ready aggregates. No I/O in here -- everything is testable
// with a plain array of bounty objects.

const MS_DAY = 24 * 60 * 60 * 1000;
const MS_WEEK = 7 * MS_DAY;

/** Reward field on the upstream API is a stringified integer in
 *  micro-USDC (6 decimals), e.g. "104860000" === 104.86 USDC. */
function toUsdc(microString) {
  const n = Number(microString);
  if (!Number.isFinite(n)) return 0;
  return n / 1_000_000;
}

/** Net USDC actually paid out (after platform fee), falls back to gross
 *  reward if the bounty hasn't been paid yet. */
function netUsdc(bounty) {
  if (bounty.payment && bounty.payment.netReward != null) {
    return toUsdc(bounty.payment.netReward);
  }
  if (bounty.pendingPayment && bounty.pendingPayment.netReward != null) {
    return toUsdc(bounty.pendingPayment.netReward);
  }
  return toUsdc(bounty.reward);
}

function grossUsdc(bounty) {
  return toUsdc(bounty.reward);
}

function isCompleted(bounty) {
  return bounty.status === 'completed';
}

/** ISO week key, e.g. "2026-W06", based on the Monday-start ISO 8601 rule. */
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((d.getTime() - firstThursday.getTime()) / MS_DAY - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
  );
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function dayKey(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function safeDate(ms) {
  if (!ms) return null;
  const d = new Date(typeof ms === 'string' ? Date.parse(ms) : ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Completion rate per ISO week, bucketed by the week each bounty was
 * *created* in. completionRate = bounties from that cohort that are
 * eventually completed / total bounties created that week.
 */
function completionRatesByWeek(bounties, { weeks = 12 } = {}) {
  const buckets = new Map();

  for (const b of bounties) {
    const created = safeDate(b.createdAt);
    if (!created) continue;
    const key = isoWeekKey(created);
    if (!buckets.has(key)) {
      buckets.set(key, { week: key, created: 0, completed: 0, weekStart: null });
    }
    const bucket = buckets.get(key);
    bucket.created += 1;
    if (isCompleted(b)) bucket.completed += 1;
    if (!bucket.weekStart || created < bucket.weekStart) bucket.weekStart = created;
  }

  const rows = [...buckets.values()]
    .sort((a, b) => a.weekStart - b.weekStart)
    .map((r) => ({
      week: r.week,
      weekStart: r.weekStart.toISOString().slice(0, 10),
      bountiesCreated: r.created,
      bountiesCompleted: r.completed,
      completionRate: r.created ? Number((r.completed / r.created).toFixed(4)) : 0,
    }));

  return rows.slice(-weeks);
}

/**
 * Average and median time-to-complete, overall and broken down by tag.
 * "Time to complete" = completedAt - claimedAt (active working time).
 * We also report the full lifecycle time (completedAt - createdAt) since
 * a bounty can sit unclaimed for a while before anyone picks it up.
 */
function timeToComplete(bounties) {
  const activeMs = [];
  const lifecycleMs = [];
  const byTag = new Map();

  for (const b of bounties) {
    if (!isCompleted(b)) continue;
    const claimed = safeDate(b.claimedAt);
    const created = safeDate(b.createdAt);
    const completed = safeDate(b.completedAt);
    if (!completed) continue;

    if (claimed && completed > claimed) {
      const ms = completed - claimed;
      activeMs.push(ms);
      for (const tag of b.tags && b.tags.length ? b.tags : ['untagged']) {
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag).push(ms);
      }
    }
    if (created && completed > created) {
      lifecycleMs.push(completed - created);
    }
  }

  const stats = (arr) => {
    if (!arr.length) return { count: 0, avgHours: 0, medianHours: 0 };
    const sorted = [...arr].sort((a, b) => a - b);
    const avg = arr.reduce((s, v) => s + v, 0) / arr.length;
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return {
      count: arr.length,
      avgHours: Number((avg / (1000 * 60 * 60)).toFixed(2)),
      medianHours: Number((median / (1000 * 60 * 60)).toFixed(2)),
    };
  };

  const byCategory = [...byTag.entries()]
    .map(([tag, arr]) => ({ tag, ...stats(arr) }))
    .sort((a, b) => b.count - a.count);

  return {
    overallActiveTime: stats(activeMs),
    overallLifecycleTime: stats(lifecycleMs),
    byCategory,
  };
}

/**
 * Top builders (claimers) ranked by net USDC earned on completed bounties.
 */
function topBuilders(bounties, { limit = 10 } = {}) {
  const byBuilder = new Map();

  for (const b of bounties) {
    if (!isCompleted(b) || !b.claimedBy) continue;
    const addr = b.claimedBy;
    if (!byBuilder.has(addr)) {
      byBuilder.set(addr, { address: addr, bountiesCompleted: 0, totalNetUsdc: 0, totalGrossUsdc: 0, tags: new Set() });
    }
    const row = byBuilder.get(addr);
    row.bountiesCompleted += 1;
    row.totalNetUsdc += netUsdc(b);
    row.totalGrossUsdc += grossUsdc(b);
    for (const tag of b.tags || []) row.tags.add(tag);
  }

  return [...byBuilder.values()]
    .map((r) => ({
      address: r.address,
      bountiesCompleted: r.bountiesCompleted,
      totalNetUsdc: Number(r.totalNetUsdc.toFixed(2)),
      totalGrossUsdc: Number(r.totalGrossUsdc.toFixed(2)),
      avgPerBountyUsdc: Number((r.totalNetUsdc / r.bountiesCompleted).toFixed(2)),
      topTags: [...r.tags].slice(0, 5),
    }))
    .sort((a, b) => b.totalNetUsdc - a.totalNetUsdc)
    .slice(0, limit);
}

/**
 * USDC reward distribution grouped by tag/category. A bounty with multiple
 * tags contributes its reward to each tag it carries (categories are not
 * mutually exclusive on this board), so totals across categories can
 * exceed the platform-wide total -- documented in the API docs.
 */
function rewardsByCategory(bounties) {
  const byTag = new Map();

  for (const b of bounties) {
    const tags = b.tags && b.tags.length ? b.tags : ['untagged'];
    for (const tag of tags) {
      if (!byTag.has(tag)) {
        byTag.set(tag, { tag, bountyCount: 0, completedCount: 0, totalGrossUsdc: 0, totalPaidUsdc: 0 });
      }
      const row = byTag.get(tag);
      row.bountyCount += 1;
      row.totalGrossUsdc += grossUsdc(b);
      if (isCompleted(b)) {
        row.completedCount += 1;
        row.totalPaidUsdc += netUsdc(b);
      }
    }
  }

  return [...byTag.values()]
    .map((r) => ({
      category: r.tag,
      bountyCount: r.bountyCount,
      completedCount: r.completedCount,
      totalGrossUsdc: Number(r.totalGrossUsdc.toFixed(2)),
      totalPaidUsdc: Number(r.totalPaidUsdc.toFixed(2)),
      avgRewardUsdc: Number((r.totalGrossUsdc / r.bountyCount).toFixed(2)),
    }))
    .sort((a, b) => b.totalGrossUsdc - a.totalGrossUsdc);
}

/**
 * Daily time series for the last N days: bounties created, bounties
 * completed, and USDC paid out. Shaped for direct use in line/bar charts.
 */
function trends(bounties, { days = 30 } = {}) {
  const since = Date.now() - days * MS_DAY;
  const byDay = new Map();

  const bump = (ms, field, amount = 1) => {
    const d = safeDate(ms);
    if (!d || d.getTime() < since) return;
    const key = dayKey(d);
    if (!byDay.has(key)) {
      byDay.set(key, { date: key, bountiesCreated: 0, bountiesCompleted: 0, usdcPaid: 0 });
    }
    byDay.get(key)[field] += amount;
  };

  for (const b of bounties) {
    bump(b.createdAt, 'bountiesCreated');
    if (isCompleted(b)) {
      bump(b.completedAt, 'bountiesCompleted');
      bump(b.completedAt, 'usdcPaid', netUsdc(b));
    }
  }

  return [...byDay.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((r) => ({ ...r, usdcPaid: Number(r.usdcPaid.toFixed(2)) }));
}

function summary(bounties) {
  const total = bounties.length;
  const completed = bounties.filter(isCompleted).length;
  const totalPaidUsdc = bounties.reduce((s, b) => s + (isCompleted(b) ? netUsdc(b) : 0), 0);
  return {
    totalBounties: total,
    completedBounties: completed,
    overallCompletionRate: total ? Number((completed / total).toFixed(4)) : 0,
    totalUsdcPaid: Number(totalPaidUsdc.toFixed(2)),
    uniqueBuilders: new Set(bounties.filter(isCompleted).map((b) => b.claimedBy).filter(Boolean)).size,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  toUsdc,
  netUsdc,
  grossUsdc,
  isCompleted,
  isoWeekKey,
  completionRatesByWeek,
  timeToComplete,
  topBuilders,
  rewardsByCategory,
  trends,
  summary,
};
