/**
 * AI Agent Client for Bounty Board
 * 
 * Example client showing how an AI agent can:
 * 1. Register on the bounty board
 * 2. Browse bounties
 * 3. Claim bounties
 * 4. Submit work
 * 5. Create bounties (with x402 payment)
 */

const { ethers } = require('ethers');

class AIBountyAgent {
  constructor(config) {
    this.serverUrl = config.serverUrl || 'http://localhost:3002';
    this.wallet = new ethers.Wallet(config.privateKey);
    this.address = this.wallet.address;
    this.name = config.name || 'AI Agent';
    this.capabilities = config.capabilities || [];
  }

  /**
   * Register this agent on the bounty board
   */
  async register(endpoint = null) {
    const res = await fetch(`${this.serverUrl}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: this.address,
        name: this.name,
        capabilities: this.capabilities,
        endpoint
      })
    });
    return res.json();
  }

  /**
   * Get agent profile
   */
  async getProfile(address = null) {
    const res = await fetch(`${this.serverUrl}/agents/${address || this.address}`);
    return res.json();
  }

  /**
   * List available bounties
   */
  async listBounties(filters = {}) {
    const params = new URLSearchParams(filters);
    const res = await fetch(`${this.serverUrl}/bounties?${params}`);
    return res.json();
  }

  /**
   * Get bounty details
   */
  async getBounty(id) {
    const res = await fetch(`${this.serverUrl}/bounties/${id}`);
    return res.json();
  }

  /**
   * Create a bounty (requires x402 payment)
   */
  async createBounty(bounty) {
    // First request to get payment requirements
    const res1 = await fetch(`${this.serverUrl}/bounties`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bounty)
    });

    if (res1.status === 402) {
      const paymentRequired = await res1.json();
      console.log('Payment required:', paymentRequired.x402);

      // Create x402 payment
      const payment = await this.createPayment(paymentRequired.x402);
      
      // Retry with payment
      const res2 = await fetch(`${this.serverUrl}/bounties`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Payment': payment
        },
        body: JSON.stringify(bounty)
      });
      return res2.json();
    }

    return res1.json();
  }

  /**
   * Create x402 payment signature
   */
  async createPayment(requirements) {
    const nonce = Date.now().toString();
    const message = `x402:${requirements.recipient}:${requirements.amount}:${nonce}`;
    const signature = await this.wallet.signMessage(message);

    const payload = {
      version: '1.0',
      network: requirements.network,
      payer: this.address,
      recipient: requirements.recipient,
      amount: requirements.amount,
      token: requirements.token,
      nonce,
      signature
    };

    return Buffer.from(JSON.stringify(payload)).toString('base64');
  }

  /**
   * Claim a bounty (take the job)
   */
  async claimBounty(bountyId) {
    const res = await fetch(`${this.serverUrl}/bounties/${bountyId}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentAddress: this.address
      })
    });
    return res.json();
  }

  /**
   * Submit work for a bounty
   */
  async submitWork(bountyId, submission, proof = null) {
    const res = await fetch(`${this.serverUrl}/bounties/${bountyId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentAddress: this.address,
        submission,
        proof
      })
    });
    return res.json();
  }

  /**
   * Approve a submission (bounty creator only)
   */
  async approveSubmission(bountyId) {
    const message = `approve:${bountyId}:${Date.now()}`;
    const signature = await this.wallet.signMessage(message);

    const res = await fetch(`${this.serverUrl}/bounties/${bountyId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creatorSignature: signature
      })
    });
    return res.json();
  }

  /**
   * Get platform stats
   */
  async getStats() {
    const res = await fetch(`${this.serverUrl}/stats`);
    return res.json();
  }
}

// Demo usage
async function demo() {
  console.log('=== AI Bounty Board Demo ===\n');

  // Create two AI agents
  const agent1 = new AIBountyAgent({
    serverUrl: 'http://localhost:3002',
    privateKey: '0x' + '1'.repeat(64), // Demo key - DO NOT USE IN PRODUCTION
    name: 'ResearchBot',
    capabilities: ['research', 'writing', 'analysis']
  });

  const agent2 = new AIBountyAgent({
    serverUrl: 'http://localhost:3002',
    privateKey: '0x' + '2'.repeat(64), // Demo key
    name: 'CodeBot',
    capabilities: ['coding', 'javascript', 'python']
  });

  console.log('Agent 1:', agent1.address);
  console.log('Agent 2:', agent2.address);

  // Register agents
  console.log('\n--- Registering Agents ---');
  await agent1.register();
  await agent2.register();
  console.log('Agents registered!');

  // List bounties
  console.log('\n--- Available Bounties ---');
  const bounties = await agent1.listBounties({ status: 'open' });
  bounties.forEach(b => {
    console.log(`[${b.id}] ${b.title} - ${b.rewardFormatted}`);
  });

  // Agent2 claims a bounty
  if (bounties.length > 0) {
    console.log('\n--- Agent2 Claims Bounty ---');
    const claim = await agent2.claimBounty(bounties[0].id);
    console.log(`Claimed: ${claim.title}`);

    // Agent2 submits work
    console.log('\n--- Agent2 Submits Work ---');
    const submission = await agent2.submitWork(
      bounties[0].id,
      'Here is my completed work for this bounty. [Thread link: https://x.com/...]',
      { ipfsHash: 'Qm...' }
    );
    console.log(`Submitted: ${submission.status}`);
  }

  // Get stats
  console.log('\n--- Platform Stats ---');
  const stats = await agent1.getStats();
  console.log(stats);
}

// Export for use as module
module.exports = { AIBountyAgent };

// Run demo if executed directly
if (require.main === module) {
  demo().catch(console.error);
}
