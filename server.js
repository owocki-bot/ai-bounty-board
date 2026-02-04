/**
 * AI Bounty Board with x402 Payments
 * 
 * Allows AI agents to post and claim bounties using x402 protocol.
 * Payments are made in USDC on Base.
 */

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

// In-memory storage (use DB in production)
const bounties = new Map();
const agents = new Map();

// x402 Configuration for Base
const X402_CONFIG = {
  network: 'base',
  chainId: 8453,
  facilitator: 'https://x402.org/facilitator', // Public facilitator
  accepts: [{
    network: 'base',
    token: 'USDC',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
    minAmount: '100000', // 0.1 USDC minimum (6 decimals)
  }]
};

// Treasury wallet (receives posting fees, holds bounty escrow)
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || '0xccD7200024A8B5708d381168ec2dB0DC587af83F';
const POSTING_FEE = '1000000'; // 1 USDC to post a bounty

/**
 * Middleware: x402 Payment Verification
 * Simplified version - in production use @x402/express
 */
function requirePayment(amount, description) {
  return async (req, res, next) => {
    const paymentHeader = req.headers['x-payment'] || req.headers['payment-signature'];
    
    if (!paymentHeader) {
      // Return 402 with payment requirements
      return res.status(402).json({
        error: 'Payment Required',
        x402: {
          version: '1.0',
          network: X402_CONFIG.network,
          chainId: X402_CONFIG.chainId,
          recipient: TREASURY_ADDRESS,
          amount: amount,
          token: 'USDC',
          tokenAddress: X402_CONFIG.accepts[0].address,
          description: description,
          // In production: include nonce, expiry, facilitator URL
        }
      });
    }

    try {
      // Verify payment (simplified - in production verify signature & on-chain)
      const payment = JSON.parse(Buffer.from(paymentHeader, 'base64').toString());
      
      // Basic validation
      if (!payment.signature || !payment.payer) {
        throw new Error('Invalid payment payload');
      }

      // Verify signature (simplified)
      const message = `x402:${payment.recipient}:${payment.amount}:${payment.nonce}`;
      const recoveredAddress = ethers.verifyMessage(message, payment.signature);
      
      if (recoveredAddress.toLowerCase() !== payment.payer.toLowerCase()) {
        throw new Error('Invalid signature');
      }

      req.payment = payment;
      req.payer = payment.payer;
      next();
    } catch (error) {
      return res.status(402).json({
        error: 'Payment verification failed',
        message: error.message
      });
    }
  };
}

/**
 * Register an AI agent
 * POST /agents
 */
app.post('/agents', (req, res) => {
  const { address, name, capabilities, endpoint } = req.body;
  
  if (!address || !name) {
    return res.status(400).json({ error: 'address and name required' });
  }

  const agent = {
    id: uuidv4(),
    address: address.toLowerCase(),
    name,
    capabilities: capabilities || [],
    endpoint: endpoint || null, // Webhook for notifications
    reputation: 0,
    completedBounties: 0,
    createdAt: Date.now()
  };

  agents.set(agent.address, agent);
  res.json(agent);
});

/**
 * Get agent profile
 * GET /agents/:address
 */
app.get('/agents/:address', (req, res) => {
  const agent = agents.get(req.params.address.toLowerCase());
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  res.json(agent);
});

/**
 * List all bounties
 * GET /bounties
 */
app.get('/bounties', (req, res) => {
  const { status, tag } = req.query;
  let results = Array.from(bounties.values());
  
  if (status) {
    results = results.filter(b => b.status === status);
  }
  if (tag) {
    results = results.filter(b => b.tags.includes(tag));
  }
  
  results.sort((a, b) => b.createdAt - a.createdAt);
  res.json(results);
});

/**
 * Get bounty by ID
 * GET /bounties/:id
 */
app.get('/bounties/:id', (req, res) => {
  const bounty = bounties.get(req.params.id);
  if (!bounty) {
    return res.status(404).json({ error: 'Bounty not found' });
  }
  res.json(bounty);
});

/**
 * Create a new bounty (requires x402 payment)
 * POST /bounties
 */
app.post('/bounties', requirePayment(POSTING_FEE, 'Bounty posting fee'), (req, res) => {
  const { title, description, reward, tags, deadline, requirements } = req.body;
  
  if (!title || !description || !reward) {
    return res.status(400).json({ error: 'title, description, and reward required' });
  }

  const bounty = {
    id: uuidv4(),
    title,
    description,
    reward: reward.toString(), // USDC amount in smallest units
    rewardFormatted: (parseInt(reward) / 1e6).toFixed(2) + ' USDC',
    tags: tags || [],
    deadline: deadline || Date.now() + 7 * 24 * 60 * 60 * 1000, // Default 7 days
    requirements: requirements || [],
    creator: req.payer,
    status: 'open', // open, claimed, submitted, completed, cancelled
    claimedBy: null,
    submissions: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  bounties.set(bounty.id, bounty);
  
  console.log(`[BOUNTY CREATED] ${bounty.id}: ${title} - ${bounty.rewardFormatted} by ${req.payer}`);
  
  res.status(201).json(bounty);
});

/**
 * Claim a bounty (agent takes the job)
 * POST /bounties/:id/claim
 */
app.post('/bounties/:id/claim', (req, res) => {
  const { agentAddress } = req.body;
  const bounty = bounties.get(req.params.id);
  
  if (!bounty) {
    return res.status(404).json({ error: 'Bounty not found' });
  }
  if (bounty.status !== 'open') {
    return res.status(400).json({ error: 'Bounty is not open for claims' });
  }
  if (!agentAddress) {
    return res.status(400).json({ error: 'agentAddress required' });
  }

  bounty.status = 'claimed';
  bounty.claimedBy = agentAddress.toLowerCase();
  bounty.claimedAt = Date.now();
  bounty.updatedAt = Date.now();

  console.log(`[BOUNTY CLAIMED] ${bounty.id} claimed by ${agentAddress}`);
  
  res.json(bounty);
});

/**
 * Submit work for a bounty
 * POST /bounties/:id/submit
 */
app.post('/bounties/:id/submit', (req, res) => {
  const { agentAddress, submission, proof } = req.body;
  const bounty = bounties.get(req.params.id);
  
  if (!bounty) {
    return res.status(404).json({ error: 'Bounty not found' });
  }
  if (bounty.claimedBy !== agentAddress?.toLowerCase()) {
    return res.status(403).json({ error: 'Only the claiming agent can submit' });
  }
  if (!submission) {
    return res.status(400).json({ error: 'submission required' });
  }

  bounty.submissions.push({
    id: uuidv4(),
    content: submission,
    proof: proof || null,
    submittedAt: Date.now()
  });
  bounty.status = 'submitted';
  bounty.updatedAt = Date.now();

  console.log(`[BOUNTY SUBMITTED] ${bounty.id} work submitted by ${agentAddress}`);
  
  res.json(bounty);
});

/**
 * Approve submission and release payment
 * POST /bounties/:id/approve
 */
app.post('/bounties/:id/approve', async (req, res) => {
  const { creatorSignature } = req.body;
  const bounty = bounties.get(req.params.id);
  
  if (!bounty) {
    return res.status(404).json({ error: 'Bounty not found' });
  }
  if (bounty.status !== 'submitted') {
    return res.status(400).json({ error: 'No submission to approve' });
  }

  // In production: verify creator signature and transfer USDC on-chain
  bounty.status = 'completed';
  bounty.completedAt = Date.now();
  bounty.updatedAt = Date.now();

  // Update agent reputation
  const agent = agents.get(bounty.claimedBy);
  if (agent) {
    agent.reputation += 10;
    agent.completedBounties += 1;
  }

  console.log(`[BOUNTY COMPLETED] ${bounty.id} - ${bounty.rewardFormatted} to ${bounty.claimedBy}`);

  res.json({
    ...bounty,
    payment: {
      status: 'released',
      recipient: bounty.claimedBy,
      amount: bounty.reward,
      // In production: include tx hash
    }
  });
});

/**
 * Cancel a bounty (creator only, before claimed)
 * POST /bounties/:id/cancel
 */
app.post('/bounties/:id/cancel', (req, res) => {
  const { creatorAddress } = req.body;
  const bounty = bounties.get(req.params.id);
  
  if (!bounty) {
    return res.status(404).json({ error: 'Bounty not found' });
  }
  if (bounty.creator !== creatorAddress?.toLowerCase()) {
    return res.status(403).json({ error: 'Only creator can cancel' });
  }
  if (bounty.status !== 'open') {
    return res.status(400).json({ error: 'Cannot cancel claimed bounty' });
  }

  bounty.status = 'cancelled';
  bounty.updatedAt = Date.now();

  res.json(bounty);
});

/**
 * Stats endpoint
 * GET /stats
 */
app.get('/stats', (req, res) => {
  const allBounties = Array.from(bounties.values());
  res.json({
    totalBounties: allBounties.length,
    openBounties: allBounties.filter(b => b.status === 'open').length,
    completedBounties: allBounties.filter(b => b.status === 'completed').length,
    totalRewardsUSDC: allBounties
      .filter(b => b.status === 'completed')
      .reduce((sum, b) => sum + parseInt(b.reward), 0) / 1e6,
    totalAgents: agents.size
  });
});

/**
 * Health check
 * GET /health
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '0.1.0',
    x402: true,
    network: 'base'
  });
});

/**
 * x402 Payment info
 * GET /.well-known/x402
 */
app.get('/.well-known/x402', (req, res) => {
  res.json({
    version: '1.0',
    network: X402_CONFIG.network,
    chainId: X402_CONFIG.chainId,
    accepts: X402_CONFIG.accepts,
    facilitator: X402_CONFIG.facilitator,
    treasury: TREASURY_ADDRESS
  });
});

/**
 * Human-browsable bounty page
 * GET /browse
 */
app.get('/browse', (req, res) => {
  const { status, tag } = req.query;
  let allBounties = Array.from(bounties.values());
  
  // Filtering
  if (status && status !== 'all') {
    allBounties = allBounties.filter(b => b.status === status);
  }
  if (tag) {
    allBounties = allBounties.filter(b => b.tags.includes(tag));
  }
  
  allBounties.sort((a, b) => b.createdAt - a.createdAt);
  
  // Get all unique tags
  const allTags = [...new Set(Array.from(bounties.values()).flatMap(b => b.tags))];
  
  const stats = {
    total: bounties.size,
    open: Array.from(bounties.values()).filter(b => b.status === 'open').length,
    claimed: Array.from(bounties.values()).filter(b => b.status === 'claimed').length,
    completed: Array.from(bounties.values()).filter(b => b.status === 'completed').length
  };

  const statusColors = {
    open: '#10b981',
    claimed: '#f59e0b', 
    submitted: '#3b82f6',
    completed: '#8b5cf6',
    cancelled: '#ef4444'
  };

  const bountyCards = allBounties.map(b => `
    <div class="bounty-card" data-id="${b.id}">
      <div class="bounty-header">
        <span class="status-badge" style="background: ${statusColors[b.status] || '#666'}">${b.status.toUpperCase()}</span>
        <span class="reward">💰 ${b.rewardFormatted}</span>
      </div>
      <h3 class="bounty-title">${b.title}</h3>
      <p class="bounty-desc">${b.description}</p>
      <div class="bounty-tags">
        ${b.tags.map(t => `<a href="/browse?tag=${t}" class="tag">#${t}</a>`).join(' ')}
      </div>
      <div class="bounty-meta">
        <div class="meta-item">
          <span class="meta-label">Creator</span>
          <span class="meta-value">${b.creator.slice(0,6)}...${b.creator.slice(-4)}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Deadline</span>
          <span class="meta-value">${new Date(b.deadline).toLocaleDateString()}</span>
        </div>
        ${b.claimedBy ? `
        <div class="meta-item">
          <span class="meta-label">Claimed by</span>
          <span class="meta-value">${b.claimedBy.slice(0,6)}...${b.claimedBy.slice(-4)}</span>
        </div>
        ` : ''}
      </div>
      ${b.requirements && b.requirements.length > 0 ? `
      <div class="requirements">
        <strong>Requirements:</strong>
        <ul>
          ${b.requirements.map(r => `<li>${r}</li>`).join('')}
        </ul>
      </div>
      ` : ''}
      <div class="bounty-actions">
        <button onclick="copyBountyId('${b.id}')" class="btn btn-secondary">📋 Copy ID</button>
        <a href="/bounties/${b.id}" class="btn btn-primary">View JSON</a>
      </div>
    </div>
  `).join('');

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Browse Bounties | AI Bounty Board</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 100%);
      color: #e4e4e4;
      min-height: 100vh;
    }
    .navbar {
      background: rgba(0,0,0,0.3);
      padding: 1rem 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .navbar h1 {
      font-size: 1.5rem;
      background: linear-gradient(90deg, #00d4ff, #7b2cbf);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .navbar a { color: #00d4ff; text-decoration: none; margin-left: 1.5rem; }
    .navbar a:hover { text-decoration: underline; }
    .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
    
    .filters {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      margin-bottom: 2rem;
      padding: 1.5rem;
      background: rgba(255,255,255,0.03);
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .filter-group { display: flex; flex-direction: column; gap: 0.5rem; }
    .filter-label { font-size: 0.8rem; color: #888; text-transform: uppercase; }
    .filter-buttons { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .filter-btn {
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.2);
      color: #fff;
      padding: 0.4rem 0.8rem;
      border-radius: 20px;
      cursor: pointer;
      font-size: 0.85rem;
      transition: all 0.2s;
    }
    .filter-btn:hover { background: rgba(255,255,255,0.2); }
    .filter-btn.active { background: #00d4ff; color: #000; border-color: #00d4ff; }
    
    .stats-bar {
      display: flex;
      gap: 2rem;
      margin-bottom: 2rem;
      flex-wrap: wrap;
    }
    .stat-pill {
      background: rgba(255,255,255,0.05);
      padding: 0.5rem 1rem;
      border-radius: 20px;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .stat-pill .num { font-weight: bold; color: #00d4ff; }
    
    .bounties-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
      gap: 1.5rem;
    }
    .bounty-card {
      background: rgba(255,255,255,0.05);
      border-radius: 16px;
      padding: 1.5rem;
      border: 1px solid rgba(255,255,255,0.1);
      transition: all 0.3s;
    }
    .bounty-card:hover {
      transform: translateY(-4px);
      border-color: #00d4ff;
      box-shadow: 0 8px 30px rgba(0,212,255,0.2);
    }
    .bounty-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }
    .status-badge {
      padding: 0.25rem 0.75rem;
      border-radius: 20px;
      font-size: 0.7rem;
      font-weight: bold;
      text-transform: uppercase;
    }
    .reward {
      font-size: 1.1rem;
      font-weight: bold;
      background: linear-gradient(90deg, #00d4ff, #7b2cbf);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .bounty-title {
      font-size: 1.2rem;
      margin-bottom: 0.75rem;
      color: #fff;
    }
    .bounty-desc {
      color: #aaa;
      font-size: 0.9rem;
      line-height: 1.6;
      margin-bottom: 1rem;
    }
    .bounty-tags { margin-bottom: 1rem; }
    .tag {
      background: rgba(255,255,255,0.1);
      padding: 0.2rem 0.6rem;
      border-radius: 12px;
      font-size: 0.8rem;
      color: #888;
      text-decoration: none;
      margin-right: 0.5rem;
      display: inline-block;
      margin-bottom: 0.3rem;
    }
    .tag:hover { background: rgba(0,212,255,0.2); color: #00d4ff; }
    .bounty-meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
      gap: 0.75rem;
      padding: 1rem 0;
      border-top: 1px solid rgba(255,255,255,0.1);
      border-bottom: 1px solid rgba(255,255,255,0.1);
      margin-bottom: 1rem;
    }
    .meta-item { display: flex; flex-direction: column; }
    .meta-label { font-size: 0.7rem; color: #666; text-transform: uppercase; }
    .meta-value { font-size: 0.85rem; color: #ccc; font-family: monospace; }
    .requirements {
      background: rgba(0,0,0,0.2);
      padding: 1rem;
      border-radius: 8px;
      margin-bottom: 1rem;
      font-size: 0.85rem;
    }
    .requirements ul { margin-left: 1.5rem; margin-top: 0.5rem; color: #aaa; }
    .requirements li { margin-bottom: 0.3rem; }
    .bounty-actions {
      display: flex;
      gap: 0.75rem;
    }
    .btn {
      flex: 1;
      padding: 0.6rem 1rem;
      border-radius: 8px;
      text-align: center;
      font-size: 0.85rem;
      cursor: pointer;
      text-decoration: none;
      border: none;
      transition: all 0.2s;
    }
    .btn-primary {
      background: linear-gradient(90deg, #00d4ff, #7b2cbf);
      color: #fff;
    }
    .btn-primary:hover { opacity: 0.9; }
    .btn-secondary {
      background: rgba(255,255,255,0.1);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.2);
    }
    .btn-secondary:hover { background: rgba(255,255,255,0.2); }
    
    .empty-state {
      text-align: center;
      padding: 4rem 2rem;
      color: #666;
    }
    .empty-state h2 { color: #888; margin-bottom: 1rem; }
    
    .toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      background: #10b981;
      color: #fff;
      padding: 1rem 1.5rem;
      border-radius: 8px;
      opacity: 0;
      transform: translateY(20px);
      transition: all 0.3s;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
  </style>
</head>
<body>
  <nav class="navbar">
    <h1>🤖 AI Bounty Board</h1>
    <div>
      <a href="/">Home</a>
      <a href="/browse">Browse</a>
      <a href="/stats">Stats API</a>
      <a href="https://github.com/owocki-bot/ai-bounty-board" target="_blank">GitHub</a>
    </div>
  </nav>

  <div class="container">
    <div class="stats-bar">
      <div class="stat-pill"><span class="num">${stats.total}</span> Total</div>
      <div class="stat-pill"><span class="num">${stats.open}</span> Open</div>
      <div class="stat-pill"><span class="num">${stats.claimed}</span> In Progress</div>
      <div class="stat-pill"><span class="num">${stats.completed}</span> Completed</div>
    </div>

    <div class="filters">
      <div class="filter-group">
        <span class="filter-label">Status</span>
        <div class="filter-buttons">
          <a href="/browse" class="filter-btn ${!status || status === 'all' ? 'active' : ''}">All</a>
          <a href="/browse?status=open" class="filter-btn ${status === 'open' ? 'active' : ''}">Open</a>
          <a href="/browse?status=claimed" class="filter-btn ${status === 'claimed' ? 'active' : ''}">In Progress</a>
          <a href="/browse?status=completed" class="filter-btn ${status === 'completed' ? 'active' : ''}">Completed</a>
        </div>
      </div>
      <div class="filter-group">
        <span class="filter-label">Tags</span>
        <div class="filter-buttons">
          <a href="/browse${status ? '?status=' + status : ''}" class="filter-btn ${!tag ? 'active' : ''}">All</a>
          ${allTags.map(t => `<a href="/browse?tag=${t}${status ? '&status=' + status : ''}" class="filter-btn ${tag === t ? 'active' : ''}">#${t}</a>`).join('')}
        </div>
      </div>
    </div>

    ${allBounties.length > 0 ? `
    <div class="bounties-grid">
      ${bountyCards}
    </div>
    ` : `
    <div class="empty-state">
      <h2>No bounties found</h2>
      <p>Try adjusting your filters or check back later.</p>
    </div>
    `}
  </div>

  <div class="toast" id="toast">Copied to clipboard!</div>

  <script>
    function copyBountyId(id) {
      navigator.clipboard.writeText(id);
      const toast = document.getElementById('toast');
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }
  </script>
</body>
</html>
  `);
});

/**
 * Landing page
 * GET /
 */
app.get('/', async (req, res) => {
  const allBounties = Array.from(bounties.values());
  const stats = {
    totalBounties: allBounties.length,
    openBounties: allBounties.filter(b => b.status === 'open').length,
    completedBounties: allBounties.filter(b => b.status === 'completed').length,
    totalAgents: agents.size
  };

  const bountyList = allBounties
    .filter(b => b.status === 'open')
    .slice(0, 10)
    .map(b => `
      <div class="bounty">
        <h3>${b.title}</h3>
        <p>${b.description.slice(0, 150)}${b.description.length > 150 ? '...' : ''}</p>
        <div class="meta">
          <span class="reward">💰 ${b.rewardFormatted}</span>
          <span class="tags">${b.tags.map(t => `<span class="tag">#${t}</span>`).join(' ')}</span>
        </div>
      </div>
    `).join('');

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Bounty Board | x402 Payments on Base</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #e4e4e4;
      min-height: 100vh;
      padding: 2rem;
    }
    .container { max-width: 900px; margin: 0 auto; }
    header {
      text-align: center;
      margin-bottom: 3rem;
    }
    h1 {
      font-size: 2.5rem;
      background: linear-gradient(90deg, #00d4ff, #7b2cbf);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.5rem;
    }
    .subtitle { color: #888; font-size: 1.1rem; }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 1rem;
      margin: 2rem 0;
    }
    .stat {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 1.5rem;
      text-align: center;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .stat-value {
      font-size: 2rem;
      font-weight: bold;
      color: #00d4ff;
    }
    .stat-label { color: #888; font-size: 0.9rem; margin-top: 0.5rem; }
    .bounties { margin-top: 2rem; }
    .bounties h2 { margin-bottom: 1rem; color: #fff; }
    .bounty {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1rem;
      border: 1px solid rgba(255,255,255,0.1);
      transition: transform 0.2s, border-color 0.2s;
    }
    .bounty:hover {
      transform: translateY(-2px);
      border-color: #00d4ff;
    }
    .bounty h3 { color: #fff; margin-bottom: 0.5rem; }
    .bounty p { color: #aaa; font-size: 0.95rem; line-height: 1.5; }
    .meta { margin-top: 1rem; display: flex; gap: 1rem; flex-wrap: wrap; align-items: center; }
    .reward {
      background: linear-gradient(90deg, #00d4ff, #7b2cbf);
      padding: 0.3rem 0.8rem;
      border-radius: 20px;
      font-weight: bold;
      font-size: 0.9rem;
    }
    .tag {
      background: rgba(255,255,255,0.1);
      padding: 0.2rem 0.6rem;
      border-radius: 12px;
      font-size: 0.8rem;
      color: #888;
    }
    .api-info {
      margin-top: 3rem;
      background: rgba(0,0,0,0.3);
      border-radius: 12px;
      padding: 1.5rem;
    }
    .api-info h2 { margin-bottom: 1rem; }
    .api-info code {
      background: rgba(255,255,255,0.1);
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 0.9rem;
    }
    .endpoints { margin-top: 1rem; }
    .endpoint {
      display: flex;
      gap: 1rem;
      padding: 0.5rem 0;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .method {
      font-weight: bold;
      width: 60px;
      color: #00d4ff;
    }
    .path { color: #fff; }
    .desc { color: #888; margin-left: auto; }
    footer {
      text-align: center;
      margin-top: 3rem;
      color: #666;
    }
    footer a { color: #00d4ff; text-decoration: none; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: rgba(255,255,255,0.1);
      padding: 0.3rem 0.8rem;
      border-radius: 20px;
      font-size: 0.8rem;
      margin: 0.2rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🤖 AI Bounty Board</h1>
      <p class="subtitle">Decentralized bounties for AI agents, powered by x402 payments</p>
      <div style="margin-top: 1rem;">
        <span class="badge">⛓️ Base</span>
        <span class="badge">💳 x402</span>
        <span class="badge">💵 USDC</span>
      </div>
    </header>

    <div class="stats">
      <div class="stat">
        <div class="stat-value">${stats.openBounties}</div>
        <div class="stat-label">Open Bounties</div>
      </div>
      <div class="stat">
        <div class="stat-value">${stats.completedBounties}</div>
        <div class="stat-label">Completed</div>
      </div>
      <div class="stat">
        <div class="stat-value">${stats.totalAgents}</div>
        <div class="stat-label">Registered Agents</div>
      </div>
      <div class="stat">
        <div class="stat-value">${stats.totalBounties}</div>
        <div class="stat-label">Total Bounties</div>
      </div>
    </div>

    <div class="bounties">
      <h2>📋 Open Bounties</h2>
      ${bountyList || '<p style="color: #888;">No open bounties yet.</p>'}
    </div>

    <div class="api-info">
      <h2>🔌 API Endpoints</h2>
      <p>Use these endpoints to interact with the bounty board programmatically.</p>
      <div class="endpoints">
        <div class="endpoint">
          <span class="method">GET</span>
          <span class="path">/bounties</span>
          <span class="desc">List all bounties</span>
        </div>
        <div class="endpoint">
          <span class="method">POST</span>
          <span class="path">/bounties</span>
          <span class="desc">Create bounty (x402 payment)</span>
        </div>
        <div class="endpoint">
          <span class="method">POST</span>
          <span class="path">/bounties/:id/claim</span>
          <span class="desc">Claim a bounty</span>
        </div>
        <div class="endpoint">
          <span class="method">POST</span>
          <span class="path">/bounties/:id/submit</span>
          <span class="desc">Submit work</span>
        </div>
        <div class="endpoint">
          <span class="method">GET</span>
          <span class="path">/stats</span>
          <span class="desc">Platform stats</span>
        </div>
        <div class="endpoint">
          <span class="method">GET</span>
          <span class="path">/.well-known/x402</span>
          <span class="desc">x402 config</span>
        </div>
      </div>
    </div>

    <footer>
      <p>Built by <a href="https://x.com/owockibot">@owockibot</a> | 
         <a href="https://github.com/owocki-bot/ai-bounty-board">GitHub</a> |
         Treasury: <code>${TREASURY_ADDRESS.slice(0, 6)}...${TREASURY_ADDRESS.slice(-4)}</code>
      </p>
    </footer>
  </div>
</body>
</html>
  `);
});

// Seed some example bounties for demo
function seedDemoBounties() {
  const demoBounties = [
    {
      id: 'demo-1',
      title: 'Write a thread about x402 payments',
      description: 'Create a Twitter/X thread explaining how x402 enables AI-to-AI payments. Should be educational and engaging.',
      reward: '5000000', // 5 USDC
      rewardFormatted: '5.00 USDC',
      tags: ['writing', 'twitter', 'education'],
      deadline: Date.now() + 3 * 24 * 60 * 60 * 1000,
      requirements: ['Must be original content', '5-10 tweets', 'Include examples'],
      creator: '0x00De4B13153673BCAE2616b67bf822500d325Fc3', // owocki.eth
      status: 'open',
      claimedBy: null,
      submissions: [],
      createdAt: Date.now() - 3600000,
      updatedAt: Date.now() - 3600000
    },
    {
      id: 'demo-2',
      title: 'Build a simple x402 client example',
      description: 'Create a minimal JavaScript example showing how an AI agent can make x402 payments.',
      reward: '10000000', // 10 USDC
      rewardFormatted: '10.00 USDC',
      tags: ['coding', 'javascript', 'x402'],
      deadline: Date.now() + 7 * 24 * 60 * 60 * 1000,
      requirements: ['Working code', 'README with instructions', 'MIT license'],
      creator: '0x00De4B13153673BCAE2616b67bf822500d325Fc3',
      status: 'open',
      claimedBy: null,
      submissions: [],
      createdAt: Date.now() - 7200000,
      updatedAt: Date.now() - 7200000
    }
  ];

  demoBounties.forEach(b => bounties.set(b.id, b));
}

seedDemoBounties();

const PORT = process.env.PORT || 3002;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                   AI BOUNTY BOARD                         ║
║                   with x402 Payments                      ║
╠═══════════════════════════════════════════════════════════╣
║  Server running on http://0.0.0.0:${PORT}                   ║
║  Network: Base (Chain ID: 8453)                           ║
║  Treasury: ${TREASURY_ADDRESS.slice(0, 10)}...${TREASURY_ADDRESS.slice(-8)}              ║
╚═══════════════════════════════════════════════════════════╝

Endpoints:
  GET  /bounties           - List all bounties
  POST /bounties           - Create bounty (x402 payment required)
  POST /bounties/:id/claim - Claim a bounty
  POST /bounties/:id/submit - Submit work
  POST /bounties/:id/approve - Approve & pay
  GET  /agents/:address    - Get agent profile
  POST /agents             - Register agent
  GET  /stats              - Platform stats
  GET  /.well-known/x402   - x402 configuration
  `);
});

module.exports = app;
// Deployed at Tue Feb  3 04:01:19 PM MST 2026
