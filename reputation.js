/**
 * ERC-8004 Identity and Reputation Integration
 * Verifies agent identity on-chain and posts feedback after bounty completions
 */

const { ethers } = require('ethers');

const REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
const IDENTITY_REGISTRY = '0x75f89FfbE5C25161cBC7C903C9d8eDaf42e7bA4e'; // Correct Base registry address

const REPUTATION_ABI = [
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string calldata tag1, string calldata tag2, string calldata endpoint, string calldata feedbackURI, bytes32 feedbackHash) external'
];

const IDENTITY_ABI = [
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function totalSupply() external view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
  'function getAgentURI(uint256 tokenId) external view returns (string)'
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

function init() {
  if (reputationContract) return true;
  
  const privateKey = process.env.OWOCKIBOT_PRIVATE_KEY;
  if (!privateKey) {
    console.log('[REPUTATION] No wallet key configured - reputation posting disabled');
    return false;
  }
  
  try {
    provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
    wallet = new ethers.Wallet(privateKey, provider);
    reputationContract = new ethers.Contract(REPUTATION_REGISTRY, REPUTATION_ABI, wallet);
    identityContract = new ethers.Contract(IDENTITY_REGISTRY, IDENTITY_ABI, provider);
    console.log('[REPUTATION] Initialized with wallet:', wallet.address);
    return true;
  } catch (err) {
    console.error('[REPUTATION] Failed to initialize:', err.message);
    return false;
  }
}

/**
 * Check if a wallet has a registered ERC-8004 agent identity
 * Queries the on-chain registry directly
 */
async function hasAgentIdentity(walletAddress) {
  if (!identityContract) {
    init();
  }
  if (!identityContract) return false;
  
  try {
    // Try to get the first agent owned by this wallet
    const agentId = await identityContract.tokenOfOwnerByIndex(walletAddress, 0);
    return agentId > 0;
  } catch {
    // No agents owned by this wallet
    return false;
  }
}

/**
 * Look up agent ID by wallet address
 * Queries the ERC-8004 registry on-chain, with known agents as fallback
 */
async function getAgentId(walletAddress) {
  const normalized = walletAddress.toLowerCase();
  
  // First try on-chain lookup
  if (identityContract) {
    try {
      const agentId = await identityContract.tokenOfOwnerByIndex(walletAddress, 0);
      if (agentId > 0) {
        // Cache for future reference
        KNOWN_AGENTS[normalized] = Number(agentId);
        return Number(agentId);
      }
    } catch {
      // Agent not found on-chain
    }
  }
  
  // Fallback to known agents
  if (KNOWN_AGENTS[normalized]) {
    return KNOWN_AGENTS[normalized];
  }
  
  return null;
}

/**
 * Get agent metadata from ERC-8004 registry
 */
async function getAgentMetadata(agentId) {
  if (!identityContract) {
    init();
  }
  if (!identityContract) return null;
  
  try {
    const uri = await identityContract.getAgentURI(agentId);
    
    // Fetch metadata if it's a valid URL
    if (uri.startsWith('http') || uri.startsWith('ipfs://')) {
      const metadataUrl = uri.startsWith('ipfs://') 
        ? `https://ipfs.io/ipfs/${uri.slice(7)}`
        : uri;
      
      const response = await fetch(metadataUrl);
      if (response.ok) {
        return await response.json();
      }
    }
    
    return { uri };
  } catch (err) {
    console.error(`[REPUTATION] Failed to get metadata for agent ${agentId}:`, err.message);
    return null;
  }
}

/**
 * Validate that a wallet can claim bounties (has ERC-8004 identity)
 */
async function validateBountyClaim(claimerAddress) {
  const agentId = await getAgentId(claimerAddress);
  
  if (!agentId) {
    return {
      valid: false,
      agentId: null,
      reason: 'No ERC-8004 agent identity found. Register at https://erc8004.org first.',
    };
  }
  
  return {
    valid: true,
    agentId,
  };
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
  if (!init()) {
    console.log('[REPUTATION] Skipping - not initialized');
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
  if (!init()) {
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
  if (!init()) {
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

module.exports = {
  init,
  hasAgentIdentity,
  getAgentId,
  getAgentMetadata,
  validateBountyClaim,
  registerAgent,
  postBountyReputation,
  postCommitmentReputation,
  postValidatorReputation,
  KNOWN_AGENTS
};
