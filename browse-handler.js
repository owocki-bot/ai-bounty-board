/**
 * Human-browsable bounty page with 1-click claim UI
 * GET /browse
 */
function registerBrowseHandler(app, getAllBounties) {

app.get('/browse', async (req, res) => {
  try {
  const { status, tag, page = 1 } = req.query;
  const perPage = 15; // Limit to 15 bounties per page for faster loading
  const pageNum = Math.max(1, parseInt(page) || 1);
  
  let allBounties = await getAllBounties();
  console.log('[BROWSE] Loaded', allBounties.length, 'bounties');

  // Keep unfiltered bounties for profile section
  const allBountiesUnfiltered = [...allBounties];

  if (status && status !== 'all') {
    allBounties = allBounties.filter(b => b.status === status);
  }
  if (tag) {
    allBounties = allBounties.filter(b => b.tags && b.tags.includes(tag));
  }

  allBounties.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  
  // Pagination
  const totalBounties = allBounties.length;
  const totalPages = Math.ceil(totalBounties / perPage);
  const startIdx = (pageNum - 1) * perPage;
  const paginatedBounties = allBounties.slice(startIdx, startIdx + perPage);

  const allTags = [...new Set(allBounties.flatMap(b => b.tags || []))];

  const stats = {
    total: allBounties.length,
    open: allBounties.filter(b => b.status === 'open').length,
    claimed: allBounties.filter(b => b.status === 'claimed').length,
    completed: allBounties.filter(b => b.status === 'completed').length
  };

  function esc(str) {
    if (typeof str !== 'string') str = String(str || '');
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  const statusColors = {
    open: '#10b981', claimed: '#f59e0b', submitted: '#3b82f6',
    completed: '#8b5cf6', cancelled: '#ef4444'
  };

  const bountyCards = paginatedBounties.map(b => {
    const subs = (b.submissions || []);
    const tagsHtml = (b.tags || []).map(t => '<a href="/browse?tag=' + t + '" class="tag">#' + esc(t) + '</a>').join(' ');
    const reqsHtml = (b.requirements && b.requirements.length > 0)
      ? '<div class="requirements"><strong>Requirements:</strong><ul>' + b.requirements.map(r => '<li>' + esc(r) + '</li>').join('') + '</ul></div>'
      : '';
    const claimedMeta = b.claimedBy
      ? '<div class="meta-item"><span class="meta-label">Claimed by</span><span class="meta-value">' + b.claimedBy.slice(0,6) + '...' + b.claimedBy.slice(-4) + '</span></div>'
      : '';
    const subsHtml = subs.length > 0
      ? '<div class="submissions-section"><h4 class="submissions-title">📝 Submissions (' + subs.length + ')</h4>' +
        subs.map(s => {
          const proofLink = s.proof ? '<a href="' + esc(s.proof) + '" target="_blank" class="submission-link">🔗 ' + esc(s.proof) + '</a>' : '';
          const editedTag = s.editedAt ? ' (edited)' : '';
          return '<div class="submission-item" data-sub-id="' + s.id + '">' +
            '<div class="submission-body">' + proofLink +
            '<p class="submission-content">' + esc(s.content || '') + '</p>' +
            '<span class="submission-time">' + new Date(s.submittedAt).toLocaleString() + editedTag + '</span></div>' +
            '<div class="submission-btns">' +
            '<button class="btn-sm btn-edit" data-bounty-id="' + b.id + '" data-sub-id="' + s.id + '">✏️</button>' +
            '<button class="btn-sm btn-del" data-bounty-id="' + b.id + '" data-sub-id="' + s.id + '">🗑️</button>' +
            '</div></div>';
        }).join('') +
        '</div>'
      : '';

    let actionBtns = '';
    if (b.status === 'open') {
      actionBtns += '<button class="btn btn-claim" data-bounty-id="' + b.id + '">🎯 Claim This Bounty</button>';
    }
    if (b.status === 'claimed' || b.status === 'submitted') {
      const label = b.status === 'claimed' ? '📤 Submit Proof' : '📤 Add Submission';
      actionBtns += '<button class="btn btn-submit-proof" data-bounty-id="' + b.id + '">' + label + '</button>';
    }
    actionBtns += '<button class="btn btn-secondary btn-copy" data-bounty-id="' + b.id + '">📋 ID</button>';
    actionBtns += '<a href="/bounties/' + b.id + '" class="btn btn-secondary">JSON</a>';

    return '<div class="bounty-card" data-id="' + esc(b.id) + '">' +
      '<div class="bounty-header">' +
      '<span class="status-badge" style="background:' + (statusColors[b.status] || '#666') + '">' + (b.status || '').toUpperCase() + '</span>' +
      '<span class="reward">💰 ' + esc(b.rewardFormatted) + '</span></div>' +
      '<h3 class="bounty-title">' + esc(b.title) + '</h3>' +
      '<p class="bounty-desc">' + esc(b.description) + '</p>' +
      '<div class="bounty-tags">' + tagsHtml + '</div>' +
      '<div class="bounty-meta">' +
      '<div class="meta-item"><span class="meta-label">Creator</span><span class="meta-value">' + (b.creator || '').slice(0,6) + '...' + (b.creator || '').slice(-4) + '</span></div>' +
      '<div class="meta-item"><span class="meta-label">Deadline</span><span class="meta-value">' + new Date(b.deadline).toLocaleDateString() + '</span></div>' +
      claimedMeta + '</div>' +
      reqsHtml + subsHtml +
      '<div class="bounty-actions">' + actionBtns + '</div></div>';
  }).join('');

  const bountiesJson = JSON.stringify(allBounties.map(b => ({
    id: b.id, title: b.title, description: b.description, status: b.status,
    reward: b.reward, rewardFormatted: b.rewardFormatted, claimedBy: b.claimedBy,
    submissions: (b.submissions || []).map(s => ({
      id: s.id, content: s.content, proof: s.proof, submittedAt: s.submittedAt, editedAt: s.editedAt
    }))
  })));

  // All bounties for profile section (unfiltered)
  const allBountiesJson = JSON.stringify(allBountiesUnfiltered.map(b => ({
    id: b.id, title: b.title, status: b.status, reward: b.reward, 
    rewardFormatted: b.rewardFormatted, claimedBy: b.claimedBy, creator: b.creator
  })));

  const filterTagsHtml = allTags.map(t => {
    const isActive = tag === t ? ' active' : '';
    const href = '/browse?tag=' + t + (status ? '&status=' + status : '');
    return '<a href="' + href + '" class="filter-btn' + isActive + '">#' + esc(t) + '</a>';
  }).join('');

  // Build pagination controls
  const buildPageUrl = (p) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (tag) params.set('tag', tag);
    params.set('page', p);
    return '/browse?' + params.toString();
  };
  
  let paginationHtml = '';
  if (totalPages > 1) {
    paginationHtml = '<div class="pagination">';
    if (pageNum > 1) {
      paginationHtml += '<a href="' + buildPageUrl(pageNum - 1) + '" class="page-btn">← Prev</a>';
    }
    paginationHtml += '<span class="page-info">Page ' + pageNum + ' of ' + totalPages + ' (' + totalBounties + ' bounties)</span>';
    if (pageNum < totalPages) {
      paginationHtml += '<a href="' + buildPageUrl(pageNum + 1) + '" class="page-btn">Next →</a>';
    }
    paginationHtml += '</div>';
  }

  const gridHtml = paginatedBounties.length > 0
    ? '<div class="bounties-grid">' + bountyCards + '</div>' + paginationHtml
    : '<div class="empty-state"><h2>No bounties found</h2><p>Try adjusting your filters or check back later.</p></div>';

  const statusFilterActive = (s) => (!status || status === 'all') && s === 'all' || status === s ? ' active' : '';

  res.send('<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<title>Browse Bounties | AI Bounty Board</title>\n' +
    '<style>\n' +
    '* { box-sizing: border-box; margin: 0; padding: 0; }\n' +
    'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 100%); color: #e4e4e4; min-height: 100vh; }\n' +
    '.navbar { background: rgba(0,0,0,0.3); padding: 1rem 2rem; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); flex-wrap: wrap; gap: 0.5rem; }\n' +
    '.navbar h1 { font-size: 1.5rem; background: linear-gradient(90deg, #00d4ff, #7b2cbf); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }\n' +
    '.nav-links a { color: #00d4ff; text-decoration: none; margin-left: 1.5rem; }\n' +
    '.nav-links a:hover { text-decoration: underline; }\n' +
    '.container { max-width: 1200px; margin: 0 auto; padding: 2rem; }\n' +
    '.wallet-bar { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; padding: 1rem 1.5rem; background: rgba(255,255,255,0.03); border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); flex-wrap: wrap; }\n' +
    '.wallet-bar .label { color: #888; font-size: 0.85rem; }\n' +
    '.wallet-bar .addr { font-family: monospace; color: #00d4ff; background: rgba(0,212,255,0.1); padding: 0.3rem 0.8rem; border-radius: 8px; font-size: 0.85rem; }\n' +
    '.wallet-bar input[type="text"] { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 0.5rem 0.8rem; border-radius: 8px; font-family: monospace; font-size: 0.85rem; width: 320px; max-width: 100%; }\n' +
    '.wallet-bar input[type="text"]::placeholder { color: #555; }\n' +
    '.btn-wallet { background: linear-gradient(90deg, #f6851b, #e2761b); color: #fff; border: none; padding: 0.5rem 1rem; border-radius: 8px; cursor: pointer; font-size: 0.85rem; font-weight: 600; }\n' +
    '.btn-wallet:hover { opacity: 0.9; }\n' +
    '.btn-wallet-disconnect { background: rgba(255,255,255,0.1); color: #ef4444; border: 1px solid rgba(239,68,68,0.3); padding: 0.4rem 0.8rem; border-radius: 8px; cursor: pointer; font-size: 0.8rem; }\n' +
    '.btn-set-addr { background: #10b981; color: #fff; border: none; padding: 0.5rem 1rem; border-radius: 8px; cursor: pointer; font-size: 0.85rem; }\n' +
    '.wallet-divider { color: #444; font-size: 0.8rem; }\n' +
    '.profile-section { margin-bottom: 1.5rem; padding: 1.5rem; background: rgba(255,255,255,0.03); border-radius: 12px; border: 1px solid rgba(0,212,255,0.2); }\n' +
    '.profile-header-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }\n' +
    '.profile-title { font-size: 1.2rem; color: #fff; margin: 0; }\n' +
    '.profile-toggle { background: none; border: none; color: #00d4ff; font-size: 1rem; cursor: pointer; padding: 0.25rem 0.5rem; }\n' +
    '.profile-stats { display: flex; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap; }\n' +
    '.profile-stat { background: rgba(255,255,255,0.05); padding: 0.5rem 1rem; border-radius: 8px; text-align: center; min-width: 80px; }\n' +
    '.profile-stat .num { font-size: 1.25rem; font-weight: bold; color: #00d4ff; display: block; }\n' +
    '.profile-stat .label { font-size: 0.7rem; color: #888; }\n' +
    '.profile-tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }\n' +
    '.profile-tab { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 0.5rem 1rem; border-radius: 8px; cursor: pointer; font-size: 0.85rem; transition: all 0.2s; }\n' +
    '.profile-tab:hover { background: rgba(255,255,255,0.2); }\n' +
    '.profile-tab.active { background: #00d4ff; color: #000; border-color: #00d4ff; }\n' +
    '.profile-bounties { max-height: 400px; overflow-y: auto; }\n' +
    '.profile-bounty-item { display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 1rem; background: rgba(255,255,255,0.03); border-radius: 8px; margin-bottom: 0.5rem; border: 1px solid rgba(255,255,255,0.06); }\n' +
    '.profile-bounty-item:hover { border-color: rgba(0,212,255,0.3); }\n' +
    '.profile-bounty-info { flex: 1; min-width: 0; }\n' +
    '.profile-bounty-title { color: #fff; font-size: 0.9rem; margin-bottom: 0.25rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n' +
    '.profile-bounty-meta { display: flex; gap: 1rem; font-size: 0.75rem; color: #888; }\n' +
    '.profile-bounty-reward { color: #00d4ff; font-weight: bold; font-size: 0.9rem; white-space: nowrap; }\n' +
    '.profile-empty { text-align: center; padding: 2rem; color: #666; }\n' +
    '.profile-content.collapsed { display: none; }\n' +
    '.stats-bar { display: flex; gap: 2rem; margin-bottom: 2rem; flex-wrap: wrap; }\n' +
    '.stat-pill { background: rgba(255,255,255,0.05); padding: 0.5rem 1rem; border-radius: 20px; display: flex; align-items: center; gap: 0.5rem; }\n' +
    '.stat-pill .num { font-weight: bold; color: #00d4ff; }\n' +
    '.filters { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 2rem; padding: 1.5rem; background: rgba(255,255,255,0.03); border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); }\n' +
    '.filter-group { display: flex; flex-direction: column; gap: 0.5rem; }\n' +
    '.filter-label { font-size: 0.8rem; color: #888; text-transform: uppercase; }\n' +
    '.filter-buttons { display: flex; gap: 0.5rem; flex-wrap: wrap; }\n' +
    '.filter-btn { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 0.4rem 0.8rem; border-radius: 20px; cursor: pointer; font-size: 0.85rem; transition: all 0.2s; text-decoration: none; }\n' +
    '.filter-btn:hover { background: rgba(255,255,255,0.2); }\n' +
    '.filter-btn.active { background: #00d4ff; color: #000; border-color: #00d4ff; }\n' +
    '.bounties-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 1.5rem; }\n' +
    '.bounty-card { background: rgba(255,255,255,0.05); border-radius: 16px; padding: 1.5rem; border: 1px solid rgba(255,255,255,0.1); transition: all 0.3s; }\n' +
    '.bounty-card:hover { transform: translateY(-4px); border-color: #00d4ff; box-shadow: 0 8px 30px rgba(0,212,255,0.15); }\n' +
    '.bounty-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }\n' +
    '.status-badge { padding: 0.25rem 0.75rem; border-radius: 20px; font-size: 0.7rem; font-weight: bold; text-transform: uppercase; }\n' +
    '.reward { font-size: 1.1rem; font-weight: bold; background: linear-gradient(90deg, #00d4ff, #7b2cbf); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }\n' +
    '.bounty-title { font-size: 1.2rem; margin-bottom: 0.75rem; color: #fff; }\n' +
    '.bounty-desc { color: #aaa; font-size: 0.9rem; line-height: 1.6; margin-bottom: 1rem; }\n' +
    '.bounty-tags { margin-bottom: 1rem; }\n' +
    '.tag { background: rgba(255,255,255,0.1); padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.8rem; color: #888; text-decoration: none; margin-right: 0.5rem; display: inline-block; margin-bottom: 0.3rem; }\n' +
    '.tag:hover { background: rgba(0,212,255,0.2); color: #00d4ff; }\n' +
    '.bounty-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 0.75rem; padding: 1rem 0; border-top: 1px solid rgba(255,255,255,0.1); border-bottom: 1px solid rgba(255,255,255,0.1); margin-bottom: 1rem; }\n' +
    '.meta-item { display: flex; flex-direction: column; }\n' +
    '.meta-label { font-size: 0.7rem; color: #666; text-transform: uppercase; }\n' +
    '.meta-value { font-size: 0.85rem; color: #ccc; font-family: monospace; }\n' +
    '.requirements { background: rgba(0,0,0,0.2); padding: 1rem; border-radius: 8px; margin-bottom: 1rem; font-size: 0.85rem; }\n' +
    '.requirements ul { margin-left: 1.5rem; margin-top: 0.5rem; color: #aaa; }\n' +
    '.requirements li { margin-bottom: 0.3rem; }\n' +
    '.submissions-section { margin-bottom: 1rem; padding: 1rem; background: rgba(0,0,0,0.2); border-radius: 10px; }\n' +
    '.submissions-title { font-size: 0.9rem; margin-bottom: 0.75rem; color: #ccc; }\n' +
    '.submission-item { display: flex; justify-content: space-between; align-items: flex-start; padding: 0.75rem; background: rgba(255,255,255,0.03); border-radius: 8px; margin-bottom: 0.5rem; border: 1px solid rgba(255,255,255,0.06); }\n' +
    '.submission-body { flex: 1; min-width: 0; }\n' +
    '.submission-link { color: #00d4ff; font-size: 0.8rem; word-break: break-all; display: block; margin-bottom: 0.3rem; text-decoration: none; }\n' +
    '.submission-link:hover { text-decoration: underline; }\n' +
    '.submission-content { color: #aaa; font-size: 0.85rem; margin-bottom: 0.25rem; }\n' +
    '.submission-time { font-size: 0.7rem; color: #555; }\n' +
    '.submission-btns { display: flex; gap: 0.4rem; margin-left: 0.5rem; flex-shrink: 0; }\n' +
    '.btn-sm { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: #ccc; padding: 0.3rem 0.5rem; border-radius: 6px; cursor: pointer; font-size: 0.75rem; transition: all 0.2s; }\n' +
    '.btn-sm:hover { background: rgba(255,255,255,0.15); }\n' +
    '.btn-del:hover { background: rgba(239,68,68,0.2); border-color: #ef4444; color: #ef4444; }\n' +
    '.btn-edit:hover { background: rgba(59,130,246,0.2); border-color: #3b82f6; color: #3b82f6; }\n' +
    '.bounty-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }\n' +
    '.btn { padding: 0.6rem 1rem; border-radius: 8px; text-align: center; font-size: 0.85rem; cursor: pointer; text-decoration: none; border: none; transition: all 0.2s; white-space: nowrap; }\n' +
    '.btn-claim { background: linear-gradient(90deg, #10b981, #059669); color: #fff; flex: 2; font-weight: 600; }\n' +
    '.btn-claim:hover { box-shadow: 0 4px 15px rgba(16,185,129,0.4); }\n' +
    '.btn-submit-proof { background: linear-gradient(90deg, #3b82f6, #2563eb); color: #fff; flex: 2; font-weight: 600; }\n' +
    '.btn-submit-proof:hover { box-shadow: 0 4px 15px rgba(59,130,246,0.4); }\n' +
    '.btn-primary { background: linear-gradient(90deg, #00d4ff, #7b2cbf); color: #fff; }\n' +
    '.btn-primary:hover { opacity: 0.9; }\n' +
    '.btn-secondary { background: rgba(255,255,255,0.1); color: #fff; border: 1px solid rgba(255,255,255,0.2); flex: 0; }\n' +
    '.btn-secondary:hover { background: rgba(255,255,255,0.2); }\n' +
    '.modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); z-index: 1000; justify-content: center; align-items: center; padding: 1rem; backdrop-filter: blur(4px); }\n' +
    '.modal-overlay.open { display: flex; }\n' +
    '.modal { background: #1a1a2e; border-radius: 16px; padding: 2rem; width: 100%; max-width: 500px; border: 1px solid rgba(255,255,255,0.15); box-shadow: 0 20px 60px rgba(0,0,0,0.5); position: relative; max-height: 90vh; overflow-y: auto; }\n' +
    '.modal h2 { margin-bottom: 0.25rem; font-size: 1.3rem; color: #fff; }\n' +
    '.modal .modal-sub { color: #888; font-size: 0.85rem; margin-bottom: 1.5rem; }\n' +
    '.modal-close { position: absolute; top: 1rem; right: 1rem; background: none; border: none; color: #666; font-size: 1.5rem; cursor: pointer; line-height: 1; }\n' +
    '.modal-close:hover { color: #fff; }\n' +
    '.form-group { margin-bottom: 1.25rem; }\n' +
    '.form-group label { display: block; font-size: 0.8rem; color: #999; text-transform: uppercase; margin-bottom: 0.4rem; letter-spacing: 0.5px; }\n' +
    '.form-group input, .form-group textarea { width: 100%; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); color: #fff; padding: 0.7rem 1rem; border-radius: 8px; font-size: 0.9rem; font-family: inherit; transition: border-color 0.2s; }\n' +
    '.form-group input:focus, .form-group textarea:focus { outline: none; border-color: #00d4ff; }\n' +
    '.form-group textarea { resize: vertical; min-height: 80px; }\n' +
    '.form-group .hint { font-size: 0.75rem; color: #555; margin-top: 0.3rem; }\n' +
    '.btn-modal-submit { width: 100%; padding: 0.8rem; border-radius: 8px; border: none; font-size: 1rem; font-weight: 600; cursor: pointer; transition: all 0.2s; }\n' +
    '.btn-modal-claim { background: linear-gradient(90deg, #10b981, #059669); color: #fff; }\n' +
    '.btn-modal-proof { background: linear-gradient(90deg, #3b82f6, #2563eb); color: #fff; }\n' +
    '.btn-modal-edit { background: linear-gradient(90deg, #f59e0b, #d97706); color: #fff; }\n' +
    '.btn-modal-submit:hover { opacity: 0.9; transform: translateY(-1px); }\n' +
    '.btn-modal-submit:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }\n' +
    '.modal-error { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.3); color: #ef4444; padding: 0.75rem; border-radius: 8px; font-size: 0.85rem; margin-bottom: 1rem; display: none; }\n' +
    '.modal-success { background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.3); color: #10b981; padding: 0.75rem; border-radius: 8px; font-size: 0.85rem; margin-bottom: 1rem; display: none; }\n' +
    '.empty-state { text-align: center; padding: 4rem 2rem; color: #666; }\n' +
    '.empty-state h2 { color: #888; margin-bottom: 1rem; }\n' +
    '.toast { position: fixed; bottom: 2rem; right: 2rem; padding: 1rem 1.5rem; border-radius: 8px; opacity: 0; transform: translateY(20px); transition: all 0.3s; z-index: 2000; color: #fff; }\n' +
    '.toast.show { opacity: 1; transform: translateY(0); }\n' +
    '.toast-success { background: #10b981; }\n' +
    '.toast-error { background: #ef4444; }\n' +
    '.pagination { display: flex; justify-content: center; align-items: center; gap: 1rem; padding: 2rem 0; flex-wrap: wrap; }\n' +
    '.page-btn { background: linear-gradient(90deg, #00d4ff, #7b2cbf); color: #fff; padding: 0.75rem 1.5rem; border-radius: 8px; text-decoration: none; font-weight: bold; transition: opacity 0.2s; }\n' +
    '.page-btn:hover { opacity: 0.8; }\n' +
    '.page-info { color: #888; font-size: 0.9rem; }\n' +
    '@media (max-width: 480px) { .bounties-grid { grid-template-columns: 1fr; } .navbar { padding: 1rem; } .container { padding: 1rem; } .wallet-bar { flex-direction: column; align-items: stretch; } .wallet-bar input[type="text"] { width: 100%; } }\n' +
    '</style>\n</head>\n<body>\n' +
    '<nav class="navbar"><h1>🤖 AI Bounty Board</h1><div class="nav-links"><a href="/">Home</a><a href="/browse">Browse</a><a href="/profile">My Profile</a><a href="/stats">Stats</a><a href="https://github.com/owocki-bot/ai-bounty-board" target="_blank">GitHub</a></div></nav>\n' +
    '<div class="container">\n' +
    '<!-- Wallet Bar -->\n' +
    '<div class="wallet-bar" id="wallet-bar">\n' +
    '<span class="label">🔑 Identity:</span>\n' +
    '<div id="wallet-disconnected" style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;">\n' +
    '<button class="btn-wallet" id="btn-metamask" style="display:none;" onclick="connectMetaMask()">🦊 Connect MetaMask</button>\n' +
    '<span class="wallet-divider" id="wallet-or" style="display:none;">or</span>\n' +
    '<input type="text" id="manual-address" placeholder="Paste wallet address (0x...)" />\n' +
    '<button class="btn-set-addr" onclick="setManualAddress()">Set Address</button>\n' +
    '</div>\n' +
    '<div id="wallet-connected" style="display:none;align-items:center;gap:0.75rem;flex-wrap:wrap;">\n' +
    '<span class="addr" id="display-address"></span>\n' +
    '<button class="btn-wallet-disconnect" onclick="disconnectWallet()">Disconnect</button>\n' +
    '</div>\n' +
    '</div>\n' +
    '<!-- My Profile Section (shows when connected) -->\n' +
    '<div class="profile-section" id="profile-section" style="display:none;">\n' +
    '<div class="profile-header-bar"><h2 class="profile-title">📋 My Bounties</h2><button class="profile-toggle" id="profile-toggle" onclick="toggleProfileSection()">▼</button></div>\n' +
    '<div class="profile-content" id="profile-content">\n' +
    '<div class="profile-stats" id="profile-stats"></div>\n' +
    '<div class="profile-tabs">\n' +
    '<button class="profile-tab active" data-tab="inprogress" onclick="switchProfileTab(\'inprogress\')">🔄 In Progress</button>\n' +
    '<button class="profile-tab" data-tab="submitted" onclick="switchProfileTab(\'submitted\')">📤 Submitted</button>\n' +
    '<button class="profile-tab" data-tab="completed" onclick="switchProfileTab(\'completed\')">✅ Completed</button>\n' +
    '</div>\n' +
    '<div class="profile-bounties" id="profile-bounties"></div>\n' +
    '</div></div>\n' +
    '<!-- Stats -->\n' +
    '<div class="stats-bar">' +
    '<div class="stat-pill"><span class="num">' + stats.total + '</span> Total</div>' +
    '<div class="stat-pill"><span class="num">' + stats.open + '</span> Open</div>' +
    '<div class="stat-pill"><span class="num">' + stats.claimed + '</span> In Progress</div>' +
    '<div class="stat-pill"><span class="num">' + stats.completed + '</span> Completed</div>' +
    '</div>\n' +
    '<!-- Filters -->\n' +
    '<div class="filters">' +
    '<div class="filter-group"><span class="filter-label">Status</span><div class="filter-buttons">' +
    '<a href="/browse" class="filter-btn' + ((!status || status === 'all') ? ' active' : '') + '">All</a>' +
    '<a href="/browse?status=open" class="filter-btn' + (status === 'open' ? ' active' : '') + '">Open</a>' +
    '<a href="/browse?status=claimed" class="filter-btn' + (status === 'claimed' ? ' active' : '') + '">In Progress</a>' +
    '<a href="/browse?status=completed" class="filter-btn' + (status === 'completed' ? ' active' : '') + '">Completed</a>' +
    '</div></div>' +
    '<div class="filter-group"><span class="filter-label">Tags</span><div class="filter-buttons">' +
    '<a href="/browse' + (status ? '?status=' + status : '') + '" class="filter-btn' + (!tag ? ' active' : '') + '">All</a>' +
    filterTagsHtml +
    '</div></div></div>\n' +
    gridHtml + '\n' +
    '</div>\n' +
    '<!-- Modal -->\n' +
    '<div class="modal-overlay" id="modal-overlay" onclick="if(event.target===this)closeModal()">' +
    '<div class="modal" id="modal"><button class="modal-close" onclick="closeModal()">&times;</button>' +
    '<div id="modal-content"></div></div></div>\n' +
    '<div class="toast" id="toast"></div>\n' +
    '<script>\n' +
    'var BOUNTIES = ' + bountiesJson + ';\n' +
    'var ALL_BOUNTIES = ' + allBountiesJson + ';\n' +
    'var userAddress = localStorage.getItem("bb_address") || "";\n' +
    'var walletSource = localStorage.getItem("bb_wallet_source") || "";\n' +
    '\n' +
    'function findBounty(id) { return BOUNTIES.find(function(b) { return String(b.id) === String(id); }); }\n' +
    'function escH(s) { var d = document.createElement("div"); d.textContent = s || ""; return d.innerHTML; }\n' +
    'function showToast(msg, type) { var t = document.getElementById("toast"); t.textContent = msg; t.className = "toast toast-" + (type||"success") + " show"; setTimeout(function() { t.classList.remove("show"); }, 3000); }\n' +
    'function openModal(html) { document.getElementById("modal-content").innerHTML = html; document.getElementById("modal-overlay").classList.add("open"); }\n' +
    'function closeModal() { document.getElementById("modal-overlay").classList.remove("open"); }\n' +
    '\n' +
    'function initWallet() {\n' +
    '  if (window.ethereum) { document.getElementById("btn-metamask").style.display = ""; document.getElementById("wallet-or").style.display = ""; }\n' +
    '  if (userAddress) showConnected(userAddress);\n' +
    '}\n' +
    'function connectMetaMask() {\n' +
    '  if (!window.ethereum) return showToast("MetaMask not found", "error");\n' +
    '  window.ethereum.request({ method: "eth_requestAccounts" }).then(function(accounts) {\n' +
    '    if (accounts[0]) {\n' +
    '      userAddress = accounts[0].toLowerCase();\n' +
    '      walletSource = "metamask";\n' +
    '      localStorage.setItem("bb_address", userAddress);\n' +
    '      localStorage.setItem("bb_wallet_source", "metamask");\n' +
    '      showConnected(userAddress);\n' +
    '      showToast("MetaMask connected!", "success");\n' +
    '    }\n' +
    '  }).catch(function(e) { showToast("Connection failed: " + e.message, "error"); });\n' +
    '}\n' +
    'function setManualAddress() {\n' +
    '  var addr = document.getElementById("manual-address").value.trim().toLowerCase();\n' +
    '  if (!addr.match(/^0x[a-f0-9]{40}$/i)) return showToast("Invalid address (must be 0x + 40 hex chars)", "error");\n' +
    '  userAddress = addr; walletSource = "manual";\n' +
    '  localStorage.setItem("bb_address", addr); localStorage.setItem("bb_wallet_source", "manual");\n' +
    '  showConnected(addr); showToast("Address set!", "success");\n' +
    '}\n' +
    'function disconnectWallet() {\n' +
    '  userAddress = ""; walletSource = "";\n' +
    '  localStorage.removeItem("bb_address"); localStorage.removeItem("bb_wallet_source");\n' +
    '  document.getElementById("wallet-connected").style.display = "none";\n' +
    '  document.getElementById("wallet-disconnected").style.display = "flex";\n' +
    '  document.getElementById("profile-section").style.display = "none";\n' +
    '}\n' +
    'function showConnected(addr) {\n' +
    '  document.getElementById("wallet-disconnected").style.display = "none";\n' +
    '  document.getElementById("wallet-connected").style.display = "flex";\n' +
    '  document.getElementById("display-address").textContent = addr.slice(0,6) + "..." + addr.slice(-4);\n' +
    '  renderProfileSection(addr);\n' +
    '}\n' +
    '\n' +
    'var currentProfileTab = "inprogress";\n' +
    'function renderProfileSection(addr) {\n' +
    '  var section = document.getElementById("profile-section");\n' +
    '  var addrLower = addr.toLowerCase();\n' +
    '  var myBounties = { inprogress: [], submitted: [], completed: [] };\n' +
    '  ALL_BOUNTIES.forEach(function(b) {\n' +
    '    if (b.title && b.claimedBy && b.claimedBy.toLowerCase() === addrLower) {\n' +
    '      if (b.status === "claimed") myBounties.inprogress.push(b);\n' +
    '      else if (b.status === "submitted") myBounties.submitted.push(b);\n' +
    '      else if (b.status === "completed") myBounties.completed.push(b);\n' +
    '    }\n' +
    '  });\n' +
    '  var total = myBounties.inprogress.length + myBounties.submitted.length + myBounties.completed.length;\n' +
    '  section.style.display = "block";\n' +
    '  var statsHtml = \'<div class="profile-stat"><span class="num">\' + myBounties.inprogress.length + \'</span><span class="label">In Progress</span></div>\' +\n' +
    '    \'<div class="profile-stat"><span class="num">\' + myBounties.submitted.length + \'</span><span class="label">Submitted</span></div>\' +\n' +
    '    \'<div class="profile-stat"><span class="num">\' + myBounties.completed.length + \'</span><span class="label">Completed</span></div>\';\n' +
    '  document.getElementById("profile-stats").innerHTML = statsHtml;\n' +
    '  renderProfileBounties(myBounties[currentProfileTab]);\n' +
    '}\n' +
    'function switchProfileTab(tab) {\n' +
    '  currentProfileTab = tab;\n' +
    '  document.querySelectorAll(".profile-tab").forEach(function(el) { el.classList.remove("active"); });\n' +
    '  document.querySelector(".profile-tab[data-tab=\'" + tab + "\']").classList.add("active");\n' +
    '  if (userAddress) renderProfileSection(userAddress);\n' +
    '}\n' +
    'function renderProfileBounties(bounties) {\n' +
    '  var container = document.getElementById("profile-bounties");\n' +
    '  var validBounties = (bounties || []).filter(function(b) { return b.title; });\n' +
    '  if (validBounties.length === 0) {\n' +
    '    container.innerHTML = \'<div class="profile-empty">No bounties in this category</div>\';\n' +
    '    return;\n' +
    '  }\n' +
    '  var html = validBounties.map(function(b) {\n' +
    '    return \'<div class="profile-bounty-item" onclick="scrollToBounty(\\\'\' + b.id + \'\\\')"><div class="profile-bounty-info">\' +\n' +
    '      \'<div class="profile-bounty-title">\' + escH(b.title) + \'</div>\' +\n' +
    '      \'<div class="profile-bounty-meta"><span>\' + (b.status || "").toUpperCase() + \'</span></div></div>\' +\n' +
    '      \'<div class="profile-bounty-reward">💰 \' + escH(b.rewardFormatted || "?") + \'</div></div>\';\n' +
    '  }).join("");\n' +
    '  container.innerHTML = html;\n' +
    '}\n' +
    'function scrollToBounty(id) {\n' +
    '  var card = document.querySelector(".bounty-card[data-id=\'" + id + "\']");\n' +
    '  if (card) { card.scrollIntoView({ behavior: "smooth", block: "center" }); card.style.boxShadow = "0 0 20px rgba(0,212,255,0.5)"; setTimeout(function() { card.style.boxShadow = ""; }, 2000); }\n' +
    '}\n' +
    'function toggleProfileSection() {\n' +
    '  var content = document.getElementById("profile-content");\n' +
    '  var toggle = document.getElementById("profile-toggle");\n' +
    '  if (content.classList.contains("collapsed")) {\n' +
    '    content.classList.remove("collapsed"); toggle.textContent = "▼";\n' +
    '  } else {\n' +
    '    content.classList.add("collapsed"); toggle.textContent = "▶";\n' +
    '  }\n' +
    '}\n' +
    '\n' +
    'function openClaimModal(bountyId) {\n' +
    '  var b = findBounty(bountyId); if (!b) return;\n' +
    '  openModal(\n' +
    '    \'<h2>🎯 Claim This Bounty</h2>\' +\n' +
    '    \'<p class="modal-sub">\' + escH(b.title) + \' — \' + escH(b.rewardFormatted) + \'</p>\' +\n' +
    '    \'<div class="modal-error" id="claim-error"></div>\' +\n' +
    '    \'<div class="modal-success" id="claim-success"></div>\' +\n' +
    '    \'<form id="claim-form" onsubmit="submitClaim(event, \\\'\' + bountyId + \'\\\')"><div class="form-group">\' +\n' +
    '    \'<label>Wallet Address *</label>\' +\n' +
    '    \'<input type="text" id="claim-address" value="\' + escH(userAddress) + \'" placeholder="0x..." required />\' +\n' +
    '    \'<p class="hint">The address that will receive payment if your work is approved</p></div>\' +\n' +
    '    \'<div class="form-group"><label>Name (optional)</label>\' +\n' +
    '    \'<input type="text" id="claim-name" placeholder="Your name or handle" /></div>\' +\n' +
    '    \'<button type="submit" class="btn-modal-submit btn-modal-claim" id="claim-btn">🎯 Claim Bounty</button></form>\'\n' +
    '  );\n' +
    '}\n' +
    '\n' +
    'function submitClaim(e, bountyId) {\n' +
    '  e.preventDefault();\n' +
    '  var addr = document.getElementById("claim-address").value.trim();\n' +
    '  var btn = document.getElementById("claim-btn");\n' +
    '  var errEl = document.getElementById("claim-error");\n' +
    '  var okEl = document.getElementById("claim-success");\n' +
    '  if (!addr.match(/^0x[a-f0-9]{40}$/i)) { errEl.textContent = "Invalid wallet address"; errEl.style.display = "block"; return; }\n' +
    '  btn.disabled = true; btn.textContent = "Claiming..."; errEl.style.display = "none";\n' +
    '  fetch("/bounties/" + bountyId + "/claim", {\n' +
    '    method: "POST", headers: { "Content-Type": "application/json" },\n' +
    '    body: JSON.stringify({ address: addr })\n' +
    '  }).then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || "Claim failed"); return d; }); })\n' +
    '  .then(function(data) {\n' +
    '    userAddress = addr.toLowerCase();\n' +
    '    localStorage.setItem("bb_address", userAddress);\n' +
    '    if (!walletSource) { walletSource = "manual"; localStorage.setItem("bb_wallet_source", "manual"); }\n' +
    '    showConnected(userAddress);\n' +
    '    okEl.textContent = "✅ Bounty claimed! You can now submit proof."; okEl.style.display = "block";\n' +
    '    btn.textContent = "✅ Claimed!"; setTimeout(function() { location.reload(); }, 1500);\n' +
    '  }).catch(function(err) {\n' +
    '    errEl.textContent = err.message; errEl.style.display = "block";\n' +
    '    btn.disabled = false; btn.textContent = "🎯 Claim Bounty";\n' +
    '  });\n' +
    '}\n' +
    '\n' +
    'function openSubmitModal(bountyId) {\n' +
    '  var b = findBounty(bountyId); if (!b) return;\n' +
    '  var hintAddr = b.claimedBy ? b.claimedBy.slice(0,6) + "..." + b.claimedBy.slice(-4) : "unknown";\n' +
    '  openModal(\n' +
    '    \'<h2>📤 Submit Proof</h2>\' +\n' +
    '    \'<p class="modal-sub">\' + escH(b.title) + \'</p>\' +\n' +
    '    \'<div class="modal-error" id="submit-error"></div>\' +\n' +
    '    \'<div class="modal-success" id="submit-success"></div>\' +\n' +
    '    \'<form id="submit-form" onsubmit="submitProof(event, \\\'\' + bountyId + \'\\\')"><div class="form-group">\' +\n' +
    '    \'<label>Your Address *</label>\' +\n' +
    '    \'<input type="text" id="submit-address" value="\' + escH(userAddress) + \'" placeholder="0x..." required />\' +\n' +
    '    \'<p class="hint">Must match claimer (\' + hintAddr + \')</p></div>\' +\n' +
    '    \'<div class="form-group"><label>Proof URL</label>\' +\n' +
    '    \'<input type="url" id="submit-proof-url" placeholder="https://github.com/..." />\' +\n' +
    '    \'<p class="hint">Link to your work — PR, demo, deployed site</p></div>\' +\n' +
    '    \'<div class="form-group"><label>Description *</label>\' +\n' +
    '    \'<textarea id="submit-description" placeholder="Describe what you built..." required></textarea></div>\' +\n' +
    '    \'<button type="submit" class="btn-modal-submit btn-modal-proof" id="submit-btn">📤 Submit Proof</button></form>\'\n' +
    '  );\n' +
    '}\n' +
    '\n' +
    'function submitProof(e, bountyId) {\n' +
    '  e.preventDefault();\n' +
    '  var addr = document.getElementById("submit-address").value.trim();\n' +
    '  var proof = document.getElementById("submit-proof-url").value.trim();\n' +
    '  var desc = document.getElementById("submit-description").value.trim();\n' +
    '  var btn = document.getElementById("submit-btn");\n' +
    '  var errEl = document.getElementById("submit-error");\n' +
    '  var okEl = document.getElementById("submit-success");\n' +
    '  if (!addr.match(/^0x[a-f0-9]{40}$/i)) { errEl.textContent = "Invalid address"; errEl.style.display = "block"; return; }\n' +
    '  if (!desc) { errEl.textContent = "Description required"; errEl.style.display = "block"; return; }\n' +
    '  btn.disabled = true; btn.textContent = "Submitting..."; errEl.style.display = "none";\n' +
    '  fetch("/bounties/" + bountyId + "/submit", {\n' +
    '    method: "POST", headers: { "Content-Type": "application/json" },\n' +
    '    body: JSON.stringify({ address: addr, submission: desc, proof: proof || null })\n' +
    '  }).then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || "Submit failed"); return d; }); })\n' +
    '  .then(function(data) {\n' +
    '    okEl.textContent = "✅ Proof submitted! Creator will review your work."; okEl.style.display = "block";\n' +
    '    btn.textContent = "✅ Submitted!"; setTimeout(function() { location.reload(); }, 1500);\n' +
    '  }).catch(function(err) {\n' +
    '    errEl.textContent = err.message; errEl.style.display = "block";\n' +
    '    btn.disabled = false; btn.textContent = "📤 Submit Proof";\n' +
    '  });\n' +
    '}\n' +
    '\n' +
    'function openEditModal(bountyId, subId) {\n' +
    '  var b = findBounty(bountyId); if (!b) return;\n' +
    '  var sub = b.submissions.find(function(s) { return s.id === subId; }); if (!sub) return;\n' +
    '  openModal(\n' +
    '    \'<h2>✏️ Edit Submission</h2>\' +\n' +
    '    \'<p class="modal-sub">\' + escH(b.title) + \'</p>\' +\n' +
    '    \'<div class="modal-error" id="edit-error"></div>\' +\n' +
    '    \'<div class="modal-success" id="edit-success"></div>\' +\n' +
    '    \'<form id="edit-form" onsubmit="submitEdit(event, \\\'\' + bountyId + \'\\\', \\\'\' + subId + \'\\\')"><div class="form-group">\' +\n' +
    '    \'<label>Your Address *</label>\' +\n' +
    '    \'<input type="text" id="edit-address" value="\' + escH(userAddress) + \'" placeholder="0x..." required /></div>\' +\n' +
    '    \'<div class="form-group"><label>Proof URL</label>\' +\n' +
    '    \'<input type="url" id="edit-proof-url" value="\' + escH(sub.proof || "") + \'" placeholder="https://..." /></div>\' +\n' +
    '    \'<div class="form-group"><label>Description *</label>\' +\n' +
    '    \'<textarea id="edit-description" required>\' + escH(sub.content || "") + \'</textarea></div>\' +\n' +
    '    \'<button type="submit" class="btn-modal-submit btn-modal-edit" id="edit-btn">💾 Save Changes</button></form>\'\n' +
    '  );\n' +
    '}\n' +
    '\n' +
    'function submitEdit(e, bountyId, subId) {\n' +
    '  e.preventDefault();\n' +
    '  var addr = document.getElementById("edit-address").value.trim();\n' +
    '  var proof = document.getElementById("edit-proof-url").value.trim();\n' +
    '  var desc = document.getElementById("edit-description").value.trim();\n' +
    '  var btn = document.getElementById("edit-btn");\n' +
    '  var errEl = document.getElementById("edit-error");\n' +
    '  var okEl = document.getElementById("edit-success");\n' +
    '  btn.disabled = true; btn.textContent = "Saving..."; errEl.style.display = "none";\n' +
    '  fetch("/bounties/" + bountyId + "/submissions/" + subId, {\n' +
    '    method: "PUT", headers: { "Content-Type": "application/json" },\n' +
    '    body: JSON.stringify({ address: addr, submission: desc, proof: proof || null })\n' +
    '  }).then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || "Edit failed"); return d; }); })\n' +
    '  .then(function() {\n' +
    '    okEl.textContent = "✅ Updated!"; okEl.style.display = "block";\n' +
    '    btn.textContent = "✅ Saved!"; setTimeout(function() { location.reload(); }, 1200);\n' +
    '  }).catch(function(err) {\n' +
    '    errEl.textContent = err.message; errEl.style.display = "block";\n' +
    '    btn.disabled = false; btn.textContent = "💾 Save Changes";\n' +
    '  });\n' +
    '}\n' +
    '\n' +
    'function deleteSubmission(bountyId, subId) {\n' +
    '  if (!confirm("Delete this submission? This cannot be undone.")) return;\n' +
    '  var addr = userAddress || prompt("Enter your wallet address to confirm:");\n' +
    '  if (!addr) return;\n' +
    '  fetch("/bounties/" + bountyId + "/submissions/" + subId, {\n' +
    '    method: "DELETE", headers: { "Content-Type": "application/json" },\n' +
    '    body: JSON.stringify({ address: addr })\n' +
    '  }).then(function(r) { return r.json().then(function(d) { if (!r.ok) throw new Error(d.error || "Delete failed"); return d; }); })\n' +
    '  .then(function() { showToast("Submission deleted", "success"); setTimeout(function() { location.reload(); }, 800); })\n' +
    '  .catch(function(err) { showToast(err.message, "error"); });\n' +
    '}\n' +
    '\n' +
    'function copyBountyId(id) { navigator.clipboard.writeText(id); showToast("Bounty ID copied!", "success"); }\n' +
    '\n' +
    '// Event delegation\n' +
    'document.addEventListener("click", function(e) {\n' +
    '  var t = e.target;\n' +
    '  if (t.classList.contains("btn-claim")) { e.preventDefault(); openClaimModal(t.dataset.bountyId); }\n' +
    '  else if (t.classList.contains("btn-submit-proof")) { e.preventDefault(); openSubmitModal(t.dataset.bountyId); }\n' +
    '  else if (t.classList.contains("btn-copy")) { e.preventDefault(); copyBountyId(t.dataset.bountyId); }\n' +
    '  else if (t.classList.contains("btn-edit")) { e.preventDefault(); openEditModal(t.dataset.bountyId, t.dataset.subId); }\n' +
    '  else if (t.classList.contains("btn-del")) { e.preventDefault(); deleteSubmission(t.dataset.bountyId, t.dataset.subId); }\n' +
    '});\n' +
    'document.getElementById("manual-address").addEventListener("keydown", function(e) { if (e.key === "Enter") { e.preventDefault(); setManualAddress(); } });\n' +
    'if (window.ethereum) { window.ethereum.on("accountsChanged", function(a) { if (a[0] && walletSource === "metamask") { userAddress = a[0].toLowerCase(); localStorage.setItem("bb_address", userAddress); showConnected(userAddress); } }); }\n' +
    'initWallet();\n' +
    '</script>\n' +
    '<script src="https://stats.owockibot.xyz/pixel.js" defer></script>\n' +
    '</body></html>'
  );
  } catch (err) {
    console.error('[BROWSE] Error:', err);
    res.status(500).send('<!DOCTYPE html><html><body><h1>Error loading bounties</h1><p>' + err.message + '</p><p><a href="/">Go home</a></p></body></html>');
  }
});

// Individual bounty detail page
app.get('/bounty/:id', async (req, res) => {
  try {
    const bountyId = req.params.id;
    const allBounties = await getAllBounties();
    const bounty = allBounties.find(b => String(b.id) === String(bountyId));
    
    if (!bounty) {
      return res.status(404).send('<!DOCTYPE html><html><head><title>Bounty Not Found</title><meta http-equiv="refresh" content="2;url=/browse"></head><body style="font-family:system-ui;background:#0a0a0a;color:#fff;padding:2rem;text-align:center;"><h1>Bounty #' + bountyId + ' not found</h1><p>Redirecting to bounty board...</p></body></html>');
    }
    
    function esc(str) {
      if (typeof str !== 'string') str = String(str || '');
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }
    
    const statusColors = { open: '#10b981', claimed: '#f59e0b', submitted: '#3b82f6', completed: '#8b5cf6', cancelled: '#ef4444' };
    const statusColor = statusColors[bounty.status] || '#666';
    const reward = bounty.rewardFormatted || ((bounty.reward / 1e6) + ' USDC');
    
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bounty #${bounty.id}: ${esc(bounty.title)} | owockibot</title>
  <meta name="description" content="${esc((bounty.description || '').slice(0, 160))}">
  <meta property="og:title" content="Bounty #${bounty.id}: ${esc(bounty.title)}">
  <meta property="og:description" content="${reward} reward — ${esc((bounty.description || '').slice(0, 200))}">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e5e5e5; line-height: 1.6; padding: 2rem; max-width: 800px; margin: 0 auto; }
    a { color: #ffb74d; }
    .back { margin-bottom: 1rem; display: inline-block; opacity: 0.7; }
    .back:hover { opacity: 1; }
    .card { background: #1a1a1a; border-radius: 12px; padding: 2rem; border: 1px solid #333; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap; }
    h1 { font-size: 1.5rem; color: #fff; }
    .status { padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.875rem; font-weight: 600; background: ${statusColor}22; color: ${statusColor}; }
    .reward { font-size: 1.5rem; color: #ffb74d; font-weight: 700; margin: 1rem 0; }
    .desc { color: #999; margin: 1rem 0; white-space: pre-wrap; }
    .meta { display: grid; gap: 0.5rem; margin-top: 1.5rem; font-size: 0.875rem; color: #666; }
    .meta-item { display: flex; gap: 0.5rem; }
    .meta-label { color: #888; min-width: 100px; }
    .tags { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 1rem; }
    .tag { background: #333; color: #aaa; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; }
    .actions { margin-top: 2rem; display: flex; gap: 1rem; }
    .btn { padding: 0.75rem 1.5rem; border-radius: 8px; font-weight: 600; text-decoration: none; display: inline-block; }
    .btn-primary { background: #ffb74d; color: #000; }
    .btn-secondary { background: #333; color: #fff; }
    .payment { margin-top: 1.5rem; padding: 1rem; background: #10b98122; border-radius: 8px; border: 1px solid #10b981; }
    .payment-title { color: #10b981; font-weight: 600; margin-bottom: 0.5rem; }
  </style>
</head>
<body>
  <a href="/browse" class="back">← Back to all bounties</a>
  <div class="card">
    <div class="header">
      <h1>Bounty #${bounty.id}: ${esc(bounty.title)}</h1>
      <span class="status">${bounty.status}</span>
    </div>
    <div class="reward">💰 ${reward}</div>
    <div class="desc">${esc(bounty.description || 'No description')}</div>
    ${bounty.tags && bounty.tags.length ? `<div class="tags">${bounty.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    <div class="meta">
      ${bounty.creator ? `<div class="meta-item"><span class="meta-label">Creator:</span> ${esc(bounty.creator.slice(0,8))}...</div>` : ''}
      ${bounty.claimedBy ? `<div class="meta-item"><span class="meta-label">Claimed by:</span> ${esc(bounty.claimedBy.slice(0,8))}...</div>` : ''}
      ${bounty.createdAt ? `<div class="meta-item"><span class="meta-label">Created:</span> ${new Date(bounty.createdAt).toLocaleDateString()}</div>` : ''}
      ${bounty.submissionUrl ? `<div class="meta-item"><span class="meta-label">Submission:</span> <a href="${esc(bounty.submissionUrl)}" target="_blank">${esc(bounty.submissionUrl.slice(0, 50))}...</a></div>` : ''}
    </div>
    ${bounty.payment ? '<div class="payment"><div class="payment-title">✅ Payment Complete</div><div class="meta-item"><span class="meta-label">Amount:</span> ' + (bounty.payment.netRewardFormatted || (((bounty.payment.netReward || 0) / 1e6).toFixed(2) + ' USDC')) + '</div>' + (bounty.payment.txHash ? '<div class="meta-item"><span class="meta-label">TX:</span> <a href="https://basescan.org/tx/' + bounty.payment.txHash + '" target="_blank">' + bounty.payment.txHash.slice(0,16) + '...</a></div>' : '') + '</div>' : ''}
    <div class="actions">
      ${bounty.status === 'open' ? `<a href="/browse" class="btn btn-primary">Claim This Bounty</a>` : ''}
      <a href="/browse" class="btn btn-secondary">View All Bounties</a>
    </div>
  </div>
</body>
</html>`);
  } catch (err) {
    console.error('[BOUNTY DETAIL] Error:', err);
    res.status(500).send('Error: ' + err.message);
  }
});

}

// Quick syntax check
if (typeof module !== 'undefined') module.exports = registerBrowseHandler;
