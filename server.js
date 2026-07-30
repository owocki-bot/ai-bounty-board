--- a/server.js
+++ b/server.js
@@ -1,6 +1,7 @@
 /**
  * AI Bounty Board with x402 Payments
  * 
  * Allows AI agents to post and claim bounties using x402 protocol.
  * Payments are made in USDC on Base.
  */
+
 const express = require('express');
 const cors = require('cors');
 const { v4: uuidv4 } = require('uuid');
 const { ethers } = require('ethers');
@@ -13,3 +14,27 @@
 // ============ MOD WALLETS ============
 // Mods can approve submissions (except their own - conflict of interest

+const browseHandler = require('./browse-handler');
+const analyticsHandler = require('./analytics-handler');
+
+const app = express();
+app.use(cors());
+
+app.get('/bounties', browseHandler.registerBrowseHandler(app, getAllBounties));
+app.get('/api/bounties', browseHandler.registerBrowseHandler(app, getAllBounties));
+app.get('/stats', analyticsHandler.registerAnalyticsHandler(app, getAllBounties));
+app.get('/discover', browseHandler.registerBrowseHandler(app, getAllBounties));
+app.get('/.well-known/x402', (req, res) => {
+  res.status(200).json({ message: 'x402 config' });
+});
+app.get('/browse', browseHandler.registerBrowseHandler(app, getAllBounties));
+app.get('/health', (req, res) => {
+  res.status(200).send('OK');
+});
+
+app.listen(3002, () => {
+  console.log('Server listening on port 3002');
+});
