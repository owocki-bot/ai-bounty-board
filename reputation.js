/**
 * ERC-8004 Reputation Integration
 * Posts feedback to the Reputation Registry after bounty completions
 */

const { ethers } = require('ethers');

const REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
const IDENTITY_REGISTRY = '0x75f89FfbE5C25161cBC7C903C9d8eDaf42e7bA4e';

const REPUTATION_ABI = [
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string calldata tag1, string calldata tag2, string calldata endpoint, string calldata feedbackURI, bytes32 feedbackHash) external'
];

const IDENTITY_ABI = [
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function totalSupply() external view returns (uint256)'
];

// Known agent ID mappings (wallet -> ERC-8004 agentId)
// Agents can self-report their ID, or we can query the registry
const KNOWN_AGENTS = {
  '0xec9d3032e62f68554a87d13bf60665e5b75d43dc': 2108, // owockibot
  '0x45b8e8efc26bfad6584001e9f1b42dcea6702b11': 2110, // Unclaw
  '0x06e9ac994543bd8ddff5883e17d018fae08fcd00': 2111, // Clawcian
  '0x155f202a210c6f97c8094290ab12113e06000f54': 2112, // RegenClaw
};

// Wallets that own agents - can't rate agents they own (self-feedback blocked by ERC-8004)
const OWOCKIBOT_WALLET = '0xec9d3032e62f68554a87d13bf60665e5b75d43dc';
const OWNED_AGENTS = new Set([2108, 2110, 2111, 2112]); // All currently owned by owockibot

let provider = null;
let wallet = null;
let reputationContract = null;
let identityContract = null;

// Initialize read-only contracts (like identity registry)
function initReadContracts() {
  if (provider) return true; // Already initialized

  try {
    provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
    identityContract = new ethers.Contract(IDENTITY_REGISTRY, IDENTITY_ABI, provider);
    console.log('[REPUTATION] Read contracts initialized.');
    return true;
  } catch (err) {
    console.error('[REPUTATION] Failed to initialize read contracts:', err.message);
    return false;
  }
}

// Initialize write contracts (requires private key for reputation posting)
function initWriteContracts() {
  if (reputationContract) return true; // Already initialized

  const privateKey = process.env.OWOCKIBOT_PRIVATE_KEY;
  if (!privateKey) {
    console.log('[REPUTATION] No wallet key configured - reputation posting disabled');
    return false;
  }
  
  try {
    if (!provider) initReadContracts(); // Ensure provider is set
    wallet = new ethers.Wallet(privateKey, provider);
    reputationContract = new ethers.Contract(REPUTATION_REGISTRY, REPUTATION_ABI, wallet);
    console.log('[REPUTATION] Write contracts initialized with wallet:', wallet.address);
    return true;
  } catch (err) {
    console.error('[REPUTATION] Failed to initialize write contracts:', err.message);
    return false;
  }
}

/**
 * Look up agent ID by wallet address
 * First checks known mappings, then could scan registry (expensive)
 */
async function getAgentId(walletAddress) {
  const normalized = walletAddress.toLowerCase();
  
  // Check known agents first
  if (KNOWN_AGENTS[normalized]) {
    return KNOWN_AGENTS[normalized];
  }
  
  // Could scan registry here but that's expensive
  // For now, return null if not in known list
  return null;
}

/**
 * Register a wallet -> agent ID mapping
 * Called when an agent claims a bounty and provides their agent ID
 */
function registerAgent(walletAddress, agentId) {
  KNOWN_AGENTS[walletAddress.toLowerCase()] = agentId;
  console.log(`[REPUTATION] Registered agent mapping: ${walletAddress} -> ${agentId}`);
}

/**
 * Post reputation feedback for a bounty completion
 * @param {string} walletAddress - The wallet that completed the bounty
 * @param {number} value - Score 0-100 (100 = perfect)
 * @param {string} tag1 - Primary tag (e.g., 'bounty-completed')
 * @param {string} tag2 - Secondary tag (e.g., 'quality-high')
 * @param {string} endpoint - Optional endpoint reference
 */
async function postBountyReputation(walletAddress, value = 100, tag1 = 'bounty-completed', tag2 = '', endpoint = '') {
  if (!initWriteContracts()) {
    console.log('[REPUTATION] Skipping - not initialized for writing');
    return { success: false, reason: 'not-initialized' };
  }
  
  const agentId = await getAgentId(walletAddress);
  if (!agentId) {
    console.log(`[REPUTATION] Skipping - no agent ID for wallet ${walletAddress}`);
    return { success: false, reason: 'no-agent-id', wallet: walletAddress };
  }
  
  // Check for self-feedback (ERC-8004 blocks feedback to agents owned by the sender)
  if (wallet && wallet.address.toLowerCase() === OWOCKIBOT_WALLET && OWNED_AGENTS.has(agentId)) {
    console.log(`[REPUTATION] Skipping - self-feedback blocked (agent ${agentId} owned by sender)`);
    return { success: false, reason: 'self-feedback-blocked', agentId };
  }
  
  try {
    console.log(`[REPUTATION] Posting feedback for agent ${agentId}: value=${value}, tag1=${tag1}`);
    
    const tx = await reputationContract.giveFeedback(
      agentId,
      value,
      0, // valueDecimals
      tag1,
      tag2,
      endpoint,
      '', // feedbackURI
      ethers.ZeroHash, // feedbackHash
      { gasLimit: 200000n }
    );
    
    console.log(`[REPUTATION] TX submitted: ${tx.hash}`);
    
    // Don't wait for confirmation to avoid blocking
    tx.wait().then(receipt => {
      console.log(`[REPUTATION] ✅ Confirmed in block ${receipt.blockNumber}: agent ${agentId} +${value}`);
    }).catch(err => {
      console.error(`[REPUTATION] TX failed: ${err.message}`);
    });
    
    return { 
      success: true, 
      agentId, 
      txHash: tx.hash,
      explorer: `https://basescan.org/tx/${tx.hash}`
    };
  } catch (err) {
    console.error(`[REPUTATION] Failed to post:`, err.message);
    return { success: false, reason: 'tx-failed', error: err.message };
  }
}

/**
 * Post reputation for commitment pool resolution
 */
async function postCommitmentReputation(agentId, resolved, tag2 = '') {
  if (!initWriteContracts()) {
    return { success: false, reason: 'not-initialized' };
  }
  
  const value = resolved ? 100 : 0;
  const tag1 = resolved ? 'commitment-resolved' : 'commitment-failed';
  
  try {
    const tx = await reputationContract.giveFeedback(
      agentId,
      value,
      0,
      tag1,
      tag2,
      '',
      '',
      ethers.ZeroHash,
      { gasLimit: 200000n }
    );
    
    console.log(`[REPUTATION] Commitment feedback TX: ${tx.hash}`);
    
    tx.wait().then(receipt => {
      console.log(`[REPUTATION] ✅ Commitment feedback confirmed: agent ${agentId} ${resolved ? 'success' : 'fail'}`);
    }).catch(err => {
      console.error(`[REPUTATION] Commitment TX failed: ${err.message}`);
    });
    
    return { success: true, agentId, txHash: tx.hash };
  } catch (err) {
    console.error(`[REPUTATION] Commitment feedback failed:`, err.message);
    return { success: false, reason: 'tx-failed', error: err.message };
  }
}

/**
 * Post reputation for validator voting
 */
async function postValidatorReputation(validatorAgentId) {
  if (!initWriteContracts()) {
    return { success: false, reason: 'not-initialized' };
  }
  
  try {
    const tx = await reputationContract.giveFeedback(
      validatorAgentId,
      50, // Validator participation = 50 points
      0,
      'validator-vote',
      '',
      '',
      '',
      ethers.ZeroHash,
      { gasLimit: 200000n }
    );
    
    console.log(`[REPUTATION] Validator vote TX: ${tx.hash}`);
    return { success: true, agentId: validatorAgentId, txHash: tx.hash };
  } catch (err) {
    console.error(`[REPUTATION] Validator feedback failed:`, err.message);
    return { success: false, reason: 'tx-failed', error: err.message };
  }
}

/**
 * Verify ERC-8004 agent identity by checking if wallet owns an agent NFT
 * @param {string} walletAddress - The wallet address to check
 * @returns {Promise<{hasIdentity: boolean, agentId?: number, error?: string}>}
 */
async function verifyAgentIdentity(walletAddress) {
  if (!initReadContracts()) {
    return { hasIdentity: false, error: 'not-initialized' };
  }
  
  const normalized = walletAddress.toLowerCase();
  
  // First check known agents for quick lookup
  if (KNOWN_AGENTS[normalized]) {
    return { hasIdentity: true, agentId: KNOWN_AGENTS[normalized] };
  }
  
  try {
    // Get total supply to know the range of agent IDs to check
    const totalSupply = await identityContract.totalSupply();
    console.log(`[IDENTITY] Checking ${totalSupply} agents for wallet ${walletAddress}`);
    
    // Check ownership of each agent NFT (this is expensive but necessary)
    for (let tokenId = 1; tokenId <= totalSupply; tokenId++) {
      try {
        const owner = await identityContract.ownerOf(tokenId);
        if (owner.toLowerCase() === normalized) {
          // Cache this mapping for future use
          KNOWN_AGENTS[normalized] = tokenId;
          console.log(`[IDENTITY] Found agent ${tokenId} owned by ${walletAddress}`);
          return { hasIdentity: true, agentId: tokenId };
        }
      } catch (err) {
        // Token might not exist or other error, continue
        continue;
      }
    }
    
    console.log(`[IDENTITY] No agent identity found for wallet ${walletAddress}`);
    return { hasIdentity: false };
  } catch (err) {
    console.error(`[IDENTITY] Error verifying identity for ${walletAddress}:`, err.message);
    return { hasIdentity: false, error: err.message };
  }
}

module.exports = {
  getAgentId,
  registerAgent,
  postBountyReputation,
  postCommitmentReputation,
  postValidatorReputation,
  verifyAgentIdentity,
  KNOWN_AGENTS
};
