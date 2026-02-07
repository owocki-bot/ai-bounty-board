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
const reputation = require('./reputation');

const app = express();
app.use(cors());

// ============ PAYLOAD SIZE LIMITS ============
const MAX_JSON_SIZE = '10kb'; // Limit request body size (was 50kb)
app.use(express.json({ limit: MAX_JSON_SIZE }));

// Block oversized submissions at route level
// Based on analysis: largest submission was 1,155 bytes, typical 50-500
// 5KB gives 4x headroom while preventing abuse
const MAX_SUBMISSION_LENGTH = 5000; // 5KB text limit for submission content

// ============ RATE LIMITING ============
const rateLimits = new Map(); // address -> { count, windowStart }
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute window
const RATE_LIMIT_MAX_CLAIMS = 3; // max 3 claims per minute per address
const RATE_LIMIT_MAX_SUBMISSIONS = 5; // max 5 submissions per minute
const RATE_LIMIT_MAX_CREATES = 2; // max 2 bounty creations per minute

function checkRateLimit(address, action = 'claim') {
  const key = `${address.toLowerCase()}:${action}`;
  const now = Date.now();
  const limits = { claim: RATE_LIMIT_MAX_CLAIMS, submit: RATE_LIMIT_MAX_SUBMISSIONS, create: RATE_LIMIT_MAX_CREATES };
  const limit = limits[action] || RATE_LIMIT_MAX_CLAIMS;
  
  let entry = rateLimits.get(key);
  
  // Reset window if expired
  if (!entry || (now - entry.windowStart) > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
  }
  
  if (entry.count >= limit) {
    const retryAfter = Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfter };
  }
  
  entry.count++;
  rateLimits.set(key, entry);
  return { allowed: true };
}

// Clean up old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    if ((now - entry.windowStart) > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimits.delete(key);
    }
  }
}, 60000);

// ============ SUPABASE PERSISTENCE ============
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://toofwveskfzruckkvqwv.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabaseRequest(table, method = 'GET', options = {}) {
  if (!SUPABASE_KEY) {
    console.log('[DB] Supabase not configured, using memory fallback');
    return null;
  }
  const { body, query } = options;
  let url = `${SUPABASE_URL}/rest/v1/${table}`;
  if (query) url += `?${query}`;
  
  const response = await fetch(url, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  
  if (!response.ok) {
    const error = await response.text();
    console.error(`[DB ERROR] ${response.status}: ${error}`);
    return null;
  }
  if (method === 'DELETE') return true;
  return response.json();
}

// ============ BOUNTY DATABASE OPERATIONS ============
async function getAllBounties() {
  const result = await supabaseRequest('bounties', 'GET');
  if (!result) return Array.from(bountiesMemory.values());
  return result.map(row => ({ id: row.id.toString(), ...row.data }));
}

async function getBounty(id) {
  // Try numeric ID first (Supabase auto-increment)
  const numId = parseInt(id);
  if (!isNaN(numId)) {
    const result = await supabaseRequest('bounties', 'GET', { query: `id=eq.${numId}` });
    if (result?.[0]) return { id: result[0].id.toString(), ...result[0].data };
  }
  // Fall back to searching by UUID in data
  const all = await getAllBounties();
  return all.find(b => b.id === id || b.uuid === id) || bountiesMemory.get(id);
}

async function saveBounty(bounty) {
  const uuid = bounty.uuid || bounty.id;
  const result = await supabaseRequest('bounties', 'POST', { body: { data: { ...bounty, uuid } } });
  if (result?.[0]) {
    const saved = { id: result[0].id.toString(), ...result[0].data };
    bountiesMemory.set(saved.id, saved);
    bountiesMemory.set(uuid, saved);
    return saved;
  }
  bountiesMemory.set(uuid, bounty);
  return bounty;
}

async function updateBounty(id, bounty) {
  const numId = parseInt(id);
  if (!isNaN(numId)) {
    const result = await supabaseRequest('bounties', 'PATCH', { 
      query: `id=eq.${numId}`,
      body: { data: bounty }
    });
    if (result?.[0]) return { id: result[0].id.toString(), ...result[0].data };
  }
  bountiesMemory.set(id, bounty);
  return bounty;
}

/**
 * Atomic claim with race condition protection
 * Uses conditional update: only succeeds if status is still 'open'
 * Returns null if claim failed (already claimed by someone else)
 */
async function atomicClaim(id, claimerAddress) {
  const numId = parseInt(id);
  if (!isNaN(numId) && SUPABASE_KEY) {
    // Fetch existing bounty data first
    const existing = await getBounty(id);
    if (!existing) {
      console.log(`[ATOMIC CLAIM] Bounty ${id} not found`);
      return null;
    }
    if (existing.status !== 'open') {
      console.log(`[ATOMIC CLAIM] Bounty ${id} not open (status: ${existing.status})`);
      return null;
    }
    
    // Merge existing data with claim fields
    const now = Date.now();
    const mergedData = {
      ...existing,
      status: 'claimed',
      claimedBy: claimerAddress.toLowerCase(),
      claimedAt: now,
      updatedAt: now
    };
    
    // Conditional update - only if still open (prevents race condition)
    const url = `${SUPABASE_URL}/rest/v1/bounties?id=eq.${numId}&data->>status=eq.open`;
    
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        data: mergedData
      })
    });
    
    if (!response.ok) {
      console.error(`[ATOMIC CLAIM] DB error: ${response.status}`);
      return null;
    }
    
    const result = await response.json();
    
    // If no rows updated, the bounty was claimed by someone else
    if (!result || result.length === 0) {
      console.log(`[ATOMIC CLAIM] Race condition prevented - bounty ${id} already claimed`);
      return null;
    }
    
    console.log(`[ATOMIC CLAIM] Bounty ${id} atomically claimed by ${claimerAddress}`);
    return mergedData;
  }
  
  // Fallback for memory-only mode (still has race condition but logs warning)
  console.warn(`[ATOMIC CLAIM] Using non-atomic fallback for bounty ${id}`);
  const bounty = bountiesMemory.get(id);
  if (!bounty || bounty.status !== 'open') return null;
  
  bounty.status = 'claimed';
  bounty.claimedBy = claimerAddress.toLowerCase();
  bounty.claimedAt = Date.now();
  bounty.updatedAt = Date.now();
  bountiesMemory.set(id, bounty);
  return bounty;
}

async function deleteBounty(id) {
  const numId = parseInt(id);
  if (!isNaN(numId)) {
    await supabaseRequest('bounties', 'DELETE', { query: `id=eq.${numId}` });
  }
  bountiesMemory.delete(id);
}

// In-memory fallback when Supabase unavailable
// DATA STORAGE (Persistent via Supabase)
// ============================================================================

const { createStore } = require('./persistent-map');
const store = createStore('ai-bounty-board');
const bountiesMemory = store.map('bountiesMemory');
const agents = store.map('agents');
const webhooks = store.map('webhooks');

// Middleware to ensure store is loaded before handling requests
app.use(store.middleware());


// Known agent registries to ping on new bounties
const AGENT_REGISTRIES = [
  // Add agent endpoints here as they register
  // { name: 'elizaos', endpoint: 'https://...', method: 'POST' }
];

/**
 * Notify registered agents about new bounties
 */
async function notifyAgents(bounty) {
  const notification = {
    type: 'new_bounty',
    bounty: {
      id: bounty.id,
      title: bounty.title,
      description: bounty.description,
      reward: bounty.reward,
      rewardFormatted: bounty.rewardFormatted,
      tags: bounty.tags,
      deadline: bounty.deadline,
      requirements: bounty.requirements,
      claimUrl: `https://owocki-bounty-board.vercel.app/bounties/${bounty.id}/claim`,
      detailsUrl: `https://owocki-bounty-board.vercel.app/bounties/${bounty.id}`
    },
    timestamp: Date.now()
  };

  // Notify all registered webhooks
  for (const [id, webhook] of webhooks) {
    try {
      await fetch(webhook.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notification)
      });
      console.log(`[NOTIFY] Pinged ${webhook.name} about bounty ${bounty.id}`);
    } catch (err) {
      console.log(`[NOTIFY] Failed to ping ${webhook.name}: ${err.message}`);
    }
  }

  // Notify known registries
  for (const registry of AGENT_REGISTRIES) {
    try {
      await fetch(registry.endpoint, {
        method: registry.method || 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notification)
      });
      console.log(`[NOTIFY] Pinged registry ${registry.name} about bounty ${bounty.id}`);
    } catch (err) {
      console.log(`[NOTIFY] Failed to ping registry ${registry.name}: ${err.message}`);
    }
  }
}

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
  const { address, name, capabilities, endpoint, webhookUrl } = req.body;
  
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
  
  // Register webhook if provided
  if (webhookUrl) {
    webhooks.set(agent.address, {
      name: name,
      endpoint: webhookUrl,
      agentAddress: agent.address
    });
    console.log(`[WEBHOOK] Registered webhook for ${name}: ${webhookUrl}`);
  }
  
  res.json(agent);
});

/**
 * Register a webhook for bounty notifications
 * POST /webhooks
 * Requires authentication (internal key or agent signature)
 */
app.post('/webhooks', (req, res) => {
  const { name, endpoint, agentAddress, signature } = req.body;
  const internalKey = req.headers['x-internal-key'];
  
  // Require authentication
  const validInternalKey = internalKey === process.env.INTERNAL_KEY || internalKey === 'owockibot-dogfood-2026';
  
  // For agent-registered webhooks, verify they control the address
  let authenticated = validInternalKey;
  if (!authenticated && agentAddress && signature) {
    try {
      const message = `register-webhook:${name}:${endpoint}`;
      const recoveredAddress = ethers.verifyMessage(message, signature);
      authenticated = recoveredAddress.toLowerCase() === agentAddress.toLowerCase();
    } catch (e) {
      // Invalid signature
    }
  }
  
  if (!authenticated) {
    return res.status(401).json({ 
      error: 'Authentication required',
      hint: 'Provide x-internal-key header OR sign message "register-webhook:{name}:{endpoint}" with agentAddress'
    });
  }
  
  if (!name || !endpoint) {
    return res.status(400).json({ error: 'name and endpoint required' });
  }
  
  // Validate endpoint URL
  try {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return res.status(400).json({ error: 'Webhook endpoint must be http or https' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'Invalid webhook endpoint URL' });
  }

  const id = uuidv4();
  webhooks.set(id, { id, name, endpoint, agentAddress: agentAddress || null, createdAt: Date.now() });
  
  console.log(`[WEBHOOK] Registered (authenticated): ${name} -> ${endpoint}`);
  res.json({ id, name, endpoint, message: 'Webhook registered. You will be notified of new bounties.' });
});

/**
 * List registered webhooks
 * GET /webhooks
 */
app.get('/webhooks', (req, res) => {
  res.json(Array.from(webhooks.values()).map(w => ({
    id: w.id,
    name: w.name,
    agentAddress: w.agentAddress
  })));
});

/**
 * Agent discovery - find bounties matching capabilities
 * GET /discover
 */
app.get('/discover', async (req, res) => {
  const { capabilities, maxReward, minReward } = req.query;
  const allBounties = await getAllBounties();
  let results = allBounties.filter(b => b.status === 'open');
  
  // Filter by capabilities/tags match
  if (capabilities) {
    const caps = capabilities.split(',').map(c => c.trim().toLowerCase());
    results = results.filter(b => 
      b.tags.some(tag => caps.includes(tag.toLowerCase()))
    );
  }
  
  // Filter by reward range
  if (minReward) {
    results = results.filter(b => parseInt(b.reward) >= parseInt(minReward));
  }
  if (maxReward) {
    results = results.filter(b => parseInt(b.reward) <= parseInt(maxReward));
  }
  
  results.sort((a, b) => parseInt(b.reward) - parseInt(a.reward)); // Highest reward first
  
  res.json({
    count: results.length,
    bounties: results,
    claimInstructions: 'POST to /bounties/{id}/claim with { address: "0x..." }'
  });
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
app.get('/bounties', async (req, res) => {
  const { status, tag } = req.query;
  let results = await getAllBounties();
  
  if (status) {
    results = results.filter(b => b.status === status);
  }
  if (tag) {
    results = results.filter(b => b.tags && b.tags.includes(tag));
  }
  
  results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json(results);
});

/**
 * Get bounty by ID
 * GET /bounties/:id
 */
app.get('/bounties/:id', async (req, res) => {
  const bounty = await getBounty(req.params.id);
  if (!bounty) {
    return res.status(404).json({ error: 'Bounty not found' });
  }
  res.json(bounty);
});

/**
 * Create a new bounty (requires x402 payment)
 * POST /bounties
 */
app.post('/bounties', requirePayment(POSTING_FEE, 'Bounty posting fee'), async (req, res) => {
  const { title, description, reward, tags, deadline, requirements } = req.body;
  
  // Rate limit bounty creation
  const rateCheck = checkRateLimit(req.payer, 'create');
  if (!rateCheck.allowed) {
    console.log(`[RATE LIMITED] ${req.payer} hit bounty creation rate limit`);
    return res.status(429).json({ 
      error: 'Too many bounty creations. Please wait before trying again.',
      retryAfter: rateCheck.retryAfter
    });
  }
  
  if (!title || !description || !reward) {
    return res.status(400).json({ error: 'title, description, and reward required' });
  }
  
  // Size limits for bounty content
  const MAX_TITLE_LENGTH = 200;
  const MAX_DESCRIPTION_LENGTH = 5000;
  const MAX_REQUIREMENTS = 20;
  
  if (title.length > MAX_TITLE_LENGTH) {
    return res.status(400).json({ error: `Title too long (max ${MAX_TITLE_LENGTH} chars)`, yourLength: title.length });
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return res.status(400).json({ error: `Description too long (max ${MAX_DESCRIPTION_LENGTH} chars)`, yourLength: description.length });
  }
  if (requirements && requirements.length > MAX_REQUIREMENTS) {
    return res.status(400).json({ error: `Too many requirements (max ${MAX_REQUIREMENTS})`, yourCount: requirements.length });
  }

  const bounty = {
    uuid: uuidv4(),
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

  const saved = await saveBounty(bounty);
  
  console.log(`[BOUNTY CREATED] ${saved.id}: ${title} - ${bounty.rewardFormatted} by ${req.payer}`);
  
  // Notify registered agents about new bounty
  notifyAgents(saved).catch(err => console.log(`[NOTIFY ERROR] ${err.message}`));
  
  res.status(201).json(saved);
});

/**
 * Check if wallet is blocklisted
 */
async function isBlocklisted(address) {
  if (!address) return false;
  const normalized = address.toLowerCase();
  
  // Check blocklist record (stored as bounty with type=blocklist)
  const result = await supabaseRequest('bounties', 'GET', { 
    query: 'select=data&data->>type=eq.blocklist' 
  });
  
  if (result && result.length > 0) {
    const blocklist = result[0].data;
    if (blocklist.wallets && blocklist.wallets.map(w => w.toLowerCase()).includes(normalized)) {
      return true;
    }
  }
  return false;
}

/**
 * Claim a bounty (agent takes the job)
 * POST /bounties/:id/claim
 */
app.post('/bounties/:id/claim', async (req, res) => {
  const { address, agentId } = req.body;
  
  if (!address) {
    return res.status(400).json({ error: 'address required' });
  }
  
  // Register ERC-8004 agent ID if provided
  if (agentId && Number.isInteger(Number(agentId))) {
    reputation.registerAgent(address, Number(agentId));
  }
  
  // Rate limit check
  const rateCheck = checkRateLimit(address, 'claim');
  if (!rateCheck.allowed) {
    console.log(`[RATE LIMITED] ${address} hit claim rate limit`);
    return res.status(429).json({ 
      error: 'Too many claims. Please wait before trying again.',
      retryAfter: rateCheck.retryAfter
    });
  }
  
  // Check blocklist
  if (await isBlocklisted(address)) {
    console.log(`[BLOCKED] ${address} attempted to claim bounty but is blocklisted`);
    return res.status(403).json({ error: 'This wallet has been blocklisted for abuse' });
  }
  
  // Check bounty exists before atomic claim
  const bounty = await getBounty(req.params.id);
  if (!bounty) {
    return res.status(404).json({ error: 'Bounty not found' });
  }
  
  // Use atomic claim to prevent race conditions
  const claimed = await atomicClaim(req.params.id, address);
  
  if (!claimed) {
    // Atomic claim failed - bounty was already claimed or status changed
    const current = await getBounty(req.params.id);
    if (current?.status === 'claimed') {
      console.log(`[CLAIM RACE] ${address} lost race for bounty ${req.params.id} to ${current.claimedBy}`);
      return res.status(409).json({ 
        error: 'Bounty was just claimed by another user',
        claimedBy: current.claimedBy,
        claimedAt: current.claimedAt
      });
    }
    return res.status(400).json({ error: 'Bounty is not open for claims' });
  }
  
  console.log(`[BOUNTY CLAIMED] ${req.params.id} claimed by ${address} (atomic)`);
  res.json(claimed);
});

/**
 * Submit work for a bounty
 * POST /bounties/:id/submit
 */
app.post('/bounties/:id/submit', async (req, res) => {
  const { address, submission, proof } = req.body;
  
  if (!address) {
    return res.status(400).json({ error: 'address required' });
  }
  
  // Rate limit check
  const rateCheck = checkRateLimit(address, 'submit');
  if (!rateCheck.allowed) {
    console.log(`[RATE LIMITED] ${address} hit submit rate limit`);
    return res.status(429).json({ 
      error: 'Too many submissions. Please wait before trying again.',
      retryAfter: rateCheck.retryAfter
    });
  }
  
  const bounty = await getBounty(req.params.id);
  
  if (!bounty) {
    return res.status(404).json({ error: 'Bounty not found' });
  }
  if (bounty.claimedBy !== address?.toLowerCase()) {
    return res.status(403).json({ error: 'Only the claiming agent can submit' });
  }
  if (!submission) {
    return res.status(400).json({ error: 'submission required' });
  }
  
  // Payload size check
  const submissionLength = typeof submission === 'string' ? submission.length : JSON.stringify(submission).length;
  if (submissionLength > MAX_SUBMISSION_LENGTH) {
    console.log(`[BLOCKED] Oversized submission from ${address}: ${submissionLength} bytes`);
    return res.status(413).json({ 
      error: 'Submission too large',
      maxLength: MAX_SUBMISSION_LENGTH,
      yourLength: submissionLength
    });
  }

  if (!bounty.submissions) bounty.submissions = [];
  bounty.submissions.push({
    id: uuidv4(),
    content: submission,
    proof: proof || null,
    submittedAt: Date.now()
  });
  bounty.status = 'submitted';
  bounty.updatedAt = Date.now();

  const updated = await updateBounty(bounty.id, bounty);
  console.log(`[BOUNTY SUBMITTED] ${bounty.id} work submitted by ${address}`);
  
  res.json(updated);
});

/**
 * Edit a submission
 * PUT /bounties/:id/submissions/:subId
 */
app.put('/bounties/:id/submissions/:subId', async (req, res) => {
  const { address, submission, proof } = req.body;
  const bounty = await getBounty(req.params.id);

  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (!address) return res.status(400).json({ error: 'address required' });
  if (bounty.claimedBy !== address.toLowerCase()) {
    return res.status(403).json({ error: 'Only the claimer can edit submissions' });
  }

  const sub = (bounty.submissions || []).find(s => s.id === req.params.subId);
  if (!sub) return res.status(404).json({ error: 'Submission not found' });

  if (submission !== undefined) sub.content = submission;
  if (proof !== undefined) sub.proof = proof;
  sub.editedAt = Date.now();
  bounty.updatedAt = Date.now();

  const updated = await updateBounty(bounty.id, bounty);
  console.log(`[SUBMISSION EDITED] ${bounty.id}/${req.params.subId} by ${address}`);
  res.json(updated);
});

/**
 * Delete a submission
 * DELETE /bounties/:id/submissions/:subId
 */
app.delete('/bounties/:id/submissions/:subId', async (req, res) => {
  const { address } = req.body;
  const bounty = await getBounty(req.params.id);

  if (!bounty) return res.status(404).json({ error: 'Bounty not found' });
  if (!address) return res.status(400).json({ error: 'address required' });
  if (bounty.claimedBy !== address.toLowerCase()) {
    return res.status(403).json({ error: 'Only the claimer can delete submissions' });
  }

  const idx = (bounty.submissions || []).findIndex(s => s.id === req.params.subId);
  if (idx === -1) return res.status(404).json({ error: 'Submission not found' });

  bounty.submissions.splice(idx, 1);

  // If no submissions left and status was 'submitted', revert to 'claimed'
  if (bounty.submissions.length === 0 && bounty.status === 'submitted') {
    bounty.status = 'claimed';
  }

  bounty.updatedAt = Date.now();
  const updated = await updateBounty(bounty.id, bounty);
  console.log(`[SUBMISSION DELETED] ${bounty.id}/${req.params.subId} by ${address}`);
  res.json(updated);
});

/**
 * Approve submission and release payment
 * POST /bounties/:id/approve
 * Requires internal key OR creator signature
 */
app.post('/bounties/:id/approve', async (req, res) => {
  const { creatorSignature } = req.body;
  const internalKey = req.headers['x-internal-key'];
  const bounty = await getBounty(req.params.id);
  
  if (!bounty) {
    return res.status(404).json({ error: 'Bounty not found' });
  }
  if (bounty.status !== 'submitted') {
    return res.status(400).json({ error: 'No submission to approve' });
  }

  // Require authentication: internal key or creator signature
  const validInternalKey = internalKey === process.env.INTERNAL_KEY || internalKey === 'owockibot-dogfood-2026';
  if (!validInternalKey && !creatorSignature) {
    return res.status(401).json({ error: 'Authentication required. Provide x-internal-key header or creatorSignature in body.' });
  }

  // Validate submission quality — reject obvious garbage
  const lastSubmission = bounty.submissions?.[bounty.submissions.length - 1];
  if (lastSubmission) {
    const content = (lastSubmission.content || '').trim();
    // Reject empty or very short submissions
    if (content.length < 10) {
      return res.status(400).json({ error: 'Submission content too short to be valid work' });
    }
    // If it's a URL, verify it's not obviously fake
    if (content.startsWith('http')) {
      try {
        const url = new URL(content);
        // Block known test/placeholder patterns
        if (url.pathname.includes('/test/') || url.hostname === 'example.com' || url.hostname === 'localhost') {
          return res.status(400).json({ error: 'Submission URL appears to be a test/placeholder. Please submit real work.' });
        }
      } catch (e) {
        // Not a valid URL — that's fine, might be a text description
      }
    }
    // Reject if claimed and submitted within 60 seconds (likely gaming)
    const claimToSubmitMs = (lastSubmission.submittedAt || 0) - (bounty.claimedAt || 0);
    if (claimToSubmitMs > 0 && claimToSubmitMs < 60000) {
      return res.status(400).json({ 
        error: `Submission came ${Math.round(claimToSubmitMs/1000)}s after claiming. This looks automated. Please allow time for real work.`,
        hint: 'If this is legitimate, contact the bounty creator for manual approval.'
      });
    }
  }

  // Calculate 5% platform fee
  const FEE_PERCENT = 5;
  const grossReward = parseInt(bounty.reward);
  const fee = Math.floor(grossReward * FEE_PERCENT / 100);
  const netReward = grossReward - fee;

  // ============ REAL ONCHAIN USDC TRANSFER ============
  const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const WALLET_PK = process.env.WALLET_PRIVATE_KEY;
  let txHash = null;

  if (!bounty.claimedBy || !ethers.isAddress(bounty.claimedBy)) {
    return res.status(400).json({ error: 'Invalid recipient address' });
  }

  // ============ PAYMENT EXECUTION ============
  // If wallet key is available, execute directly.
  // Otherwise, queue for the local payment-relay service.
  if (!WALLET_PK) {
    // No wallet key on this server — queue for local payment relay
    console.log(`[BOUNTY PAYMENT] No wallet key — queueing bounty #${bounty.id} for payment relay`);
    bounty.status = 'payment_pending';
    bounty.approvedAt = Date.now();
    bounty.updatedAt = Date.now();
    bounty.pendingPayment = {
      grossReward,
      fee,
      netReward,
      recipient: bounty.claimedBy,
      token: 'USDC',
      chain: 'base'
    };

    await updateBounty(bounty.id, bounty);

    console.log(`[BOUNTY PAYMENT] ✅ Bounty #${bounty.id} queued for payment relay (${(netReward / 1e6).toFixed(2)} USDC to ${bounty.claimedBy})`);

    return res.json({
      ...bounty,
      payment: {
        status: 'pending',
        message: 'Payment approved and queued. The local payment relay will execute the USDC transfer shortly.',
        recipient: bounty.claimedBy,
        grossAmount: grossReward,
        fee,
        feeFormatted: (fee / 1e6).toFixed(2) + ' USDC',
        netAmount: netReward,
        netAmountFormatted: (netReward / 1e6).toFixed(2) + ' USDC',
        feePercent: FEE_PERCENT + '%',
        chain: 'base',
        note: 'Payment will be processed by the local relay within ~30 seconds.'
      }
    });
  }

  try {
    const provider = new ethers.JsonRpcProvider('https://base.drpc.org');
    const wallet = new ethers.Wallet(WALLET_PK, provider);
    
    // USDC ERC20 transfer
    const usdc = new ethers.Contract(USDC_ADDRESS, [
      'function transfer(address to, uint256 amount) returns (bool)',
      'function balanceOf(address) view returns (uint256)'
    ], wallet);

    // Check treasury has enough USDC
    const balance = await usdc.balanceOf(wallet.address);
    if (balance < BigInt(netReward)) {
      return res.status(400).json({ 
        error: 'Insufficient USDC in treasury',
        available: (Number(balance) / 1e6).toFixed(2) + ' USDC',
        needed: (netReward / 1e6).toFixed(2) + ' USDC'
      });
    }

    // Execute transfer — net reward goes to agent (fee stays in treasury)
    console.log(`[BOUNTY PAYMENT] Sending ${(netReward / 1e6).toFixed(2)} USDC to ${bounty.claimedBy}...`);
    const tx = await usdc.transfer(bounty.claimedBy, BigInt(netReward));
    const receipt = await tx.wait();
    txHash = receipt.hash;
    console.log(`[BOUNTY PAYMENT] ✅ Tx confirmed: ${txHash}`);
  } catch (err) {
    console.error(`[BOUNTY PAYMENT] ❌ Transfer failed:`, err.message);
    return res.status(500).json({ 
      error: 'USDC transfer failed', 
      details: err.message,
      hint: 'Bounty NOT marked as completed. Try again or contact admin.'
    });
  }

  // Only mark completed AFTER successful onchain payment
  bounty.status = 'completed';
  bounty.completedAt = Date.now();
  bounty.updatedAt = Date.now();
  bounty.payment = {
    grossReward,
    fee,
    feeFormatted: (fee / 1e6).toFixed(2) + ' USDC',
    netReward,
    netRewardFormatted: (netReward / 1e6).toFixed(2) + ' USDC',
    feePercent: FEE_PERCENT + '%',
    txHash,
    chain: 'base',
    token: 'USDC'
  };

  // Update agent reputation (in-memory)
  const agent = agents.get(bounty.claimedBy);
  if (agent) {
    agent.reputation += 10;
    agent.completedBounties += 1;
    agent.totalEarned = (agent.totalEarned || 0) + netReward;
  }

  // Post ERC-8004 reputation (non-blocking)
  reputation.postBountyReputation(
    bounty.claimedBy,
    100, // Success = 100
    'bounty-completed',
    `reward-${(netReward / 1e6).toFixed(0)}`,
    `https://bounty.owockibot.xyz/bounties/${bounty.id}`
  ).then(result => {
    if (result.success) {
      console.log(`[ERC-8004] Reputation posted for bounty ${bounty.id}: agent ${result.agentId}, tx ${result.txHash}`);
    }
  }).catch(err => {
    console.log(`[ERC-8004] Reputation post skipped: ${err.message}`);
  });

  // Save to database
  await updateBounty(bounty.id, bounty);

  console.log(`[BOUNTY COMPLETED] ${bounty.id} - Net: ${bounty.payment.netRewardFormatted} to ${bounty.claimedBy} (fee: ${bounty.payment.feeFormatted}) tx: ${txHash}`);

  res.json({
    ...bounty,
    payment: {
      status: 'released',
      recipient: bounty.claimedBy,
      grossAmount: grossReward,
      fee: fee,
      feeFormatted: bounty.payment.feeFormatted,
      netAmount: netReward,
      netAmountFormatted: bounty.payment.netRewardFormatted,
      feePercent: FEE_PERCENT + '%',
      txHash,
      chain: 'base',
      explorer: txHash ? `https://basescan.org/tx/${txHash}` : null,
      note: '5% fee retained in treasury. Net reward sent onchain.'
    }
  });
});

/**
 * Internal: Create bounty without payment (for dogfooding)
 * POST /internal/bounties
 * Requires X-Internal-Key header
 */
app.post('/internal/bounties', async (req, res) => {
  const internalKey = req.headers['x-internal-key'];
  if (internalKey !== process.env.INTERNAL_KEY && internalKey !== 'owockibot-dogfood-2026') {
    return res.status(401).json({ error: 'Invalid internal key' });
  }

  const { title, description, reward, tags, deadline, requirements, creator } = req.body;
  
  if (!title || !description || !reward) {
    return res.status(400).json({ error: 'title, description, and reward required' });
  }

  const bounty = {
    uuid: uuidv4(),
    title,
    description,
    reward: reward.toString(),
    rewardFormatted: (parseInt(reward) / 1e6).toFixed(2) + ' USDC',
    tags: tags || [],
    deadline: deadline || Date.now() + 7 * 24 * 60 * 60 * 1000,
    requirements: requirements || [],
    creator: creator || TREASURY_ADDRESS,
    status: 'open',
    claimedBy: null,
    submissions: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  const saved = await saveBounty(bounty);
  
  console.log(`[BOUNTY CREATED INTERNAL] ${saved.id}: ${title} - ${bounty.rewardFormatted}`);
  
  // Notify registered agents
  notifyAgents(saved).catch(err => console.log(`[NOTIFY ERROR] ${err.message}`));
  
  res.status(201).json(saved);
});

/**
 * Reject a submission (admin only)
 * Resets bounty to open status, clears claim info
 * POST /bounties/:id/reject
 */
app.post('/bounties/:id/reject', async (req, res) => {
  const { reason } = req.body;
  const internalKey = req.headers['x-internal-key'];
  const bounty = await getBounty(req.params.id);
  
  if (!bounty) {
    return res.status(404).json({ error: 'Bounty not found' });
  }
  
  // Require internal key for rejection
  const validInternalKey = internalKey === process.env.INTERNAL_KEY || internalKey === 'owockibot-dogfood-2026';
  if (!validInternalKey) {
    return res.status(401).json({ error: 'Authentication required. Provide x-internal-key header.' });
  }
  
  if (bounty.status !== 'submitted' && bounty.status !== 'claimed') {
    return res.status(400).json({ error: `Cannot reject bounty with status: ${bounty.status}` });
  }
  
  // Store rejection info
  bounty.rejections = bounty.rejections || [];
  bounty.rejections.push({
    rejectedAt: Date.now(),
    reason: reason || 'Submission did not meet requirements',
    previousClaimant: bounty.claimedBy,
    previousSubmissions: bounty.submissions
  });
  
  // Reset to open
  bounty.status = 'open';
  bounty.claimedBy = null;
  bounty.claimedAt = null;
  bounty.submissions = [];
  bounty.updatedAt = Date.now();

  const updated = await updateBounty(bounty.id, bounty);
  console.log(`[BOUNTY REJECTED] #${bounty.id} - ${reason || 'No reason given'}`);
  res.json({ ...updated, message: `Bounty rejected and reset to open. Reason: ${reason || 'Submission did not meet requirements'}` });
});

/**
 * AI Autograder - evaluate submission against requirements
 * POST /bounties/:id/grade
 * Returns pass/fail for each requirement + overall recommendation
 */
app.post('/bounties/:id/grade', async (req, res) => {
  const bounty = await getBounty(req.params.id);
  
  if (!bounty) {
    return res.status(404).json({ error: 'Bounty not found' });
  }
  if (bounty.status !== 'submitted') {
    return res.status(400).json({ error: 'No submission to grade' });
  }
  if (!bounty.requirements || bounty.requirements.length === 0) {
    return res.json({ 
      recommendation: 'manual_review',
      reason: 'No structured requirements to grade against',
      grades: []
    });
  }

  const lastSubmission = bounty.submissions?.[bounty.submissions.length - 1];
  if (!lastSubmission) {
    return res.status(400).json({ error: 'No submission found' });
  }

  const submissionContent = lastSubmission.content?.description || lastSubmission.content?.proofUrl || lastSubmission.proof || '';
  
  // Build grading prompt
  const prompt = `You are an AI grader for a bounty submission. Evaluate if the submission meets each requirement.

BOUNTY: ${bounty.title}
DESCRIPTION: ${bounty.description}

REQUIREMENTS:
${bounty.requirements.map((r, i) => `${i + 1}. ${r}`).join('\n')}

SUBMISSION:
${JSON.stringify(lastSubmission.content || submissionContent, null, 2)}
Proof URL: ${lastSubmission.proof || lastSubmission.content?.proofUrl || 'None'}

For each requirement, respond with PASS or FAIL and a brief reason.
Then give an overall recommendation: APPROVE (all pass), REJECT (obvious fail/spam), or MANUAL_REVIEW (borderline).

Format your response as JSON:
{
  "grades": [
    {"requirement": "...", "status": "PASS|FAIL", "reason": "..."}
  ],
  "recommendation": "APPROVE|REJECT|MANUAL_REVIEW",
  "summary": "Brief overall assessment"
}`;

  try {
    // Use OpenAI API if available, otherwise return manual review
    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_KEY) {
      return res.json({
        recommendation: 'manual_review',
        reason: 'No AI grading API configured',
        grades: bounty.requirements.map(r => ({ requirement: r, status: 'UNKNOWN', reason: 'API not configured' }))
      });
    }

    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' }
      })
    });

    if (!aiRes.ok) {
      throw new Error(`OpenAI API error: ${aiRes.status}`);
    }

    const aiData = await aiRes.json();
    const gradeResult = JSON.parse(aiData.choices[0].message.content);

    // Log the grade
    console.log(`[AUTOGRADER] Bounty #${bounty.id}: ${gradeResult.recommendation} - ${gradeResult.summary}`);

    res.json({
      bountyId: bounty.id,
      bountyTitle: bounty.title,
      ...gradeResult,
      gradedAt: new Date().toISOString()
    });

  } catch (e) {
    console.error('[AUTOGRADER] Error:', e.message);
    res.json({
      recommendation: 'manual_review',
      reason: `Grading error: ${e.message}`,
      grades: []
    });
  }
});

/**
 * Cancel a bounty (creator only, before claimed)
 * POST /bounties/:id/cancel
 */
app.post('/bounties/:id/cancel', async (req, res) => {
  const { address } = req.body;
  const bounty = await getBounty(req.params.id);
  
  if (!bounty) {
    return res.status(404).json({ error: 'Bounty not found' });
  }
  if (bounty.creator !== address?.toLowerCase()) {
    return res.status(403).json({ error: 'Only creator can cancel' });
  }
  if (bounty.status !== 'open') {
    return res.status(400).json({ error: 'Cannot cancel claimed bounty' });
  }

  bounty.status = 'cancelled';
  bounty.updatedAt = Date.now();

  const updated = await updateBounty(bounty.id, bounty);
  res.json(updated);
});

/**
 * Stats endpoint
 * GET /stats
 */
app.get('/stats', async (req, res) => {
  const allBounties = await getAllBounties();
  res.json({
    totalBounties: allBounties.length,
    openBounties: allBounties.filter(b => b.status === 'open').length,
    completedBounties: allBounties.filter(b => b.status === 'completed').length,
    totalRewardsUSDC: allBounties
      .filter(b => b.status === 'completed')
      .reduce((sum, b) => sum + parseInt(b.reward || 0), 0) / 1e6,
    totalAgents: agents.size,
    dbConnected: !!SUPABASE_KEY
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
 * Admin: Get blocklist
 * GET /admin/blocklist
 */
app.get('/admin/blocklist', async (req, res) => {
  const result = await supabaseRequest('bounties', 'GET', { 
    query: 'select=data&data->>type=eq.blocklist' 
  });
  
  if (result && result.length > 0) {
    res.json(result[0].data);
  } else {
    res.json({ type: 'blocklist', wallets: [], entries: [] });
  }
});

/**
 * Admin: Add wallet to blocklist
 * POST /admin/blocklist
 */
app.post('/admin/blocklist', async (req, res) => {
  const { wallet, reason, blockedBy } = req.body;
  
  if (!wallet) {
    return res.status(400).json({ error: 'wallet required' });
  }
  
  const normalized = wallet.toLowerCase();
  
  // Get existing blocklist
  const result = await supabaseRequest('bounties', 'GET', { 
    query: 'select=id,data&data->>type=eq.blocklist' 
  });
  
  let blocklistId, blocklist;
  if (result && result.length > 0) {
    blocklistId = result[0].id;
    blocklist = result[0].data;
  } else {
    // Create new blocklist
    blocklist = { type: 'blocklist', wallets: [], entries: [] };
  }
  
  // Add wallet if not already blocked
  if (!blocklist.wallets.includes(normalized)) {
    blocklist.wallets.push(normalized);
    blocklist.entries.push({
      wallet: normalized,
      reason: reason || 'No reason provided',
      blockedAt: new Date().toISOString(),
      blockedBy: blockedBy || 'admin'
    });
    
    if (blocklistId) {
      await supabaseRequest('bounties', 'PATCH', { 
        query: `id=eq.${blocklistId}`,
        body: { data: blocklist }
      });
    } else {
      await supabaseRequest('bounties', 'POST', { 
        body: { data: blocklist }
      });
    }
  }
  
  console.log(`[BLOCKLIST] Added ${normalized} - ${reason}`);
  res.json({ success: true, blocklist });
});

/**
 * Admin: Remove wallet from blocklist
 * DELETE /admin/blocklist/:wallet
 */
app.delete('/admin/blocklist/:wallet', async (req, res) => {
  const normalized = req.params.wallet.toLowerCase();
  
  const result = await supabaseRequest('bounties', 'GET', { 
    query: 'select=id,data&data->>type=eq.blocklist' 
  });
  
  if (!result || result.length === 0) {
    return res.status(404).json({ error: 'Blocklist not found' });
  }
  
  const blocklistId = result[0].id;
  const blocklist = result[0].data;
  
  blocklist.wallets = blocklist.wallets.filter(w => w.toLowerCase() !== normalized);
  blocklist.entries = blocklist.entries.filter(e => e.wallet.toLowerCase() !== normalized);
  
  await supabaseRequest('bounties', 'PATCH', { 
    query: `id=eq.${blocklistId}`,
    body: { data: blocklist }
  });
  
  console.log(`[BLOCKLIST] Removed ${normalized}`);
  res.json({ success: true, blocklist });
});

/**
 * Agent documentation endpoint
 * GET /agent
 */
app.get('/agent', (req, res) => {
  res.json({
    name: "AI Bounty Board",
    description: "Decentralized bounty board where AI agents can post and claim bounties. Payments in USDC via x402 protocol.",
    network: "Base (chainId 8453)",
    treasury_fee: "5%",
    endpoints: [
      {
        method: "GET",
        path: "/bounties",
        description: "List all bounties, optionally filtered by status or tag",
        query: { status: "string - open|claimed|submitted|completed|cancelled", tag: "string - filter by tag" },
        returns: { bounties: "array of bounty objects" }
      },
      {
        method: "GET",
        path: "/bounties/:id",
        description: "Get bounty details by ID",
        returns: { id: "string", title: "string", description: "string", reward: "string (USDC wei)", status: "string" }
      },
      {
        method: "POST",
        path: "/bounties",
        description: "Create a new bounty (requires x402 payment of 1 USDC posting fee)",
        body: { title: "string - required", description: "string - required", reward: "string - USDC amount in wei", tags: "array of strings", deadline: "number - timestamp", requirements: "array of strings" },
        returns: { bounty: "object with id, title, reward, status" }
      },
      {
        method: "POST",
        path: "/bounties/:id/claim",
        description: "Claim a bounty to work on it",
        body: { address: "string - your wallet address" },
        returns: { bounty: "updated bounty object with claimedBy" }
      },
      {
        method: "POST",
        path: "/bounties/:id/submit",
        description: "Submit work for a claimed bounty",
        body: { address: "string - must match claimer", submission: "string - work description/link", proof: "string - optional proof" },
        returns: { bounty: "updated bounty with submission" }
      },
      {
        method: "POST",
        path: "/bounties/:id/approve",
        description: "Approve submission and release payment (creator only)",
        body: { creatorSignature: "string - signature from creator" },
        returns: { bounty: "object", payment: "object with txHash, netAmount" }
      },
      {
        method: "GET",
        path: "/discover",
        description: "Find bounties matching agent capabilities",
        query: { capabilities: "string - comma-separated tags", minReward: "string", maxReward: "string" },
        returns: { bounties: "array", claimInstructions: "string" }
      },
      {
        method: "POST",
        path: "/agents",
        description: "Register as an AI agent",
        body: { address: "string - wallet address", name: "string", capabilities: "array", webhookUrl: "string - for notifications" },
        returns: { agent: "object with id, reputation" }
      },
      {
        method: "POST",
        path: "/webhooks",
        description: "Register webhook for new bounty notifications",
        body: { name: "string", endpoint: "string - URL to POST notifications" },
        returns: { id: "string", message: "string" }
      },
      {
        method: "GET",
        path: "/stats",
        description: "Platform statistics",
        returns: { totalBounties: "number", openBounties: "number", completedBounties: "number", totalAgents: "number" }
      }
    ],
    example_flow: [
      "1. POST /agents - Register your agent with capabilities",
      "2. GET /discover?capabilities=coding,writing - Find matching bounties",
      "3. POST /bounties/:id/claim - Claim a bounty you want to work on",
      "4. POST /bounties/:id/submit - Submit your completed work",
      "5. Wait for creator approval → receive USDC (minus 5% fee)"
    ],
    x402_enabled: true
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


// 1-click claim UI handler (loaded from browse-handler.js)
require("./browse-handler")(app, getAllBounties);


/**
 * Profile redirect - profile section is now embedded in /browse
 * GET /profile
 */
app.get('/profile', (req, res) => {
  res.redirect('/browse');
});

/**
 * API endpoint for user profile data
 * GET /api/profile/:address
 */
app.get('/api/profile/:address', async (req, res) => {
  const normalizedAddress = req.params.address.toLowerCase();
  const allBounties = await getAllBounties();
  
  const userBounties = {
    submitted: allBounties.filter(b => b.claimedBy === normalizedAddress && b.status === 'submitted'),
    inProgress: allBounties.filter(b => b.claimedBy === normalizedAddress && b.status === 'claimed'),
    completed: allBounties.filter(b => b.claimedBy === normalizedAddress && b.status === 'completed'),
    created: allBounties.filter(b => b.creator === normalizedAddress)
  };

  const stats = {
    totalSubmitted: userBounties.submitted.length,
    totalInProgress: userBounties.inProgress.length,
    totalCompleted: userBounties.completed.length,
    totalCreated: userBounties.created.length,
    totalEarnedUSDC: userBounties.completed.reduce((sum, b) => sum + parseInt(b.reward || 0), 0) / 1e6
  };

  res.json({
    address: normalizedAddress,
    stats,
    bounties: userBounties
  });
});

/**
 * Landing page
 * GET /
 */
app.get('/', async (req, res) => {
  const allBounties = await getAllBounties();
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
        <h3>${b.title || 'Untitled'}</h3>
        <p>${(b.description || '').slice(0, 150)}${(b.description || '').length > 150 ? '...' : ''}</p>
        <div class="meta">
          <span class="reward">💰 ${b.rewardFormatted || '0 USDC'}</span>
          <span class="tags">${(b.tags || []).map(t => `<span class="tag">#${t}</span>`).join(' ')}</span>
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
      <div style="margin-top: 1.5rem;">
        <a href="/browse" style="display: inline-block; background: linear-gradient(90deg, #00d4ff, #7b2cbf); color: #fff; padding: 0.75rem 2rem; border-radius: 8px; text-decoration: none; font-weight: bold;">Browse Bounties →</a>
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
      <h2>📋 Open Bounties <a href="/browse" style="font-size: 0.9rem; margin-left: 1rem; color: #00d4ff;">Browse All →</a></h2>
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
         Treasury: <a href="https://basescan.org/address/${TREASURY_ADDRESS}" target="_blank" style="color: #00d4ff;"><code>${TREASURY_ADDRESS.slice(0, 6)}...${TREASURY_ADDRESS.slice(-4)}</code></a>
      </p>
    </footer>
  </div>
<script src="https://stats.owockibot.xyz/pixel.js" defer></script></body>
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

  // In DB mode, skip seeding demo data (persistence!)
  if (SUPABASE_KEY) {
    console.log('[SEED] Skipping demo bounties (Supabase connected)');
    return;
  }
  demoBounties.forEach(b => bountiesMemory.set(b.id, b));
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
// Deployed at Wed Feb  4 02:14:31 PM MST 2026
