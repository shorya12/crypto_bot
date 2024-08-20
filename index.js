/**
 * Program entry point
 * 
 * Usage:
 * npm run start
 * 
 * Note: Ensure the .env file is properly configured with the necessary environment variables.
 */
const { spawn } = require('child_process');
const path = require('path');
const ExpandSwap = require('./expandswap');
require('dotenv').config(); // Load environment variables from .env file
const util = require('util');
const setTimeoutPromise = util.promisify(setTimeout);

// Polling interval in milliseconds (10 minutes)
const POLLING_INTERVAL = 10 * 60 * 1000;

/**
 * Runs Python webscraper to scrape Roadmap data.
 * @param {string} absolutePath - The absolute path to the webscraper.
 * @returns {Promise<Object>} - An async promise that resolves to the scraped data after Roadmap_Scraper subprocess completes.
 */
function scrape(absolutePath) {
  return new Promise((resolve, reject) => {
    const pythonProcess = spawn('python3', [absolutePath]);  // Use 'python3' if 'python' doesn't work

    let dataString = '';

    pythonProcess.stdout.on('data', (data) => {
      dataString += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      console.error(`Error: ${data.toString()}`);
    });

    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Python script exited with code ${code}`));
      }
      try {
        const result = JSON.parse(dataString);
        resolve(result);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function monitorPriceAndSell(expandSwap, initialTokenPath, swappedAmount, stopLossPercentage = 0.001) {
  let maxUSDTValue = 0;

  // Create the reverse path for checking USDT value (WETH -> USDT)
  const reverseTokenPath = [initialTokenPath[1], initialTokenPath[0]];

  while (true) {
    try {
      console.log("Monitoring USDT value...");

      // Check the USDT value of the swapped WETH
      const usdtValue = await priceMonitor(expandSwap, reverseTokenPath, swappedAmount);

      // Ensure we're getting a new USDT value
      console.log(`Current USDT Value: ${usdtValue}`);

      // Update max USDT value if the current value is higher
      if (usdtValue > maxUSDTValue) {
        maxUSDTValue = usdtValue;
        console.log(`Updated Max USDT Value: ${maxUSDTValue}`);
      }

      // Check if the USDT value has dropped below the stop loss threshold
      if (usdtValue < maxUSDTValue * (1 - stopLossPercentage)) {
        console.log(`USDT value dropped more than ${stopLossPercentage * 100}% from max. Executing sell order...`);

        // Execute a market sell order to swap WETH back to USDT
        await expandSwap.executeSwap(reverseTokenPath, swappedAmount.toString());

        console.log("Sell order executed. Exiting.");
        break;
      }
    } catch (error) {
      console.error("Failed to fetch the USDT value or execute the swap:", error);
    }

    // Wait for 5 seconds before checking the price again
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}


/**
 * Creates ExpandSwap instance and executes swaps based on new instances of scraped data.
 * @param {Object} data - List of unique contract addresses from S3.
 * @returns {Promise<void>} - An async promise that resolves when all swaps are completed.
 * 
 * Note that this will only return empty lists if the S3 Bucket contains scraped CA data from previous intervals
 * This ensures that the only trades being executed are CA's that are being scraped for the first time
 */
async function processNewEntries(newEntries, amountIn) {
  //Store Expand's chainID's as dictionary mappings
   const chainIdMapping = {
    "Ethereum": "1",
    "Binance Smart Chain": "56",
    "Polygon": "137",
    "Avalanche": "43114",
    "Arbitrum": "42161",
    "Fantom": "250",
    // Add other mappings as needed
  };

  const dexIdMapping = {
      "Ethereum": "1300",
      "Binance Smart Chain": "1200",
      "Avalanche": "1305",
      "Polygon": "1307",
      "Arbitrum": "1308",
      "Base": "1309",
      "Solana": "2700"
  };

  const USDTMapping = {
    "Ethereum": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    "Solana": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    "Polygon": "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"
  };

  const boughtTokens = [];

  // First, buy all the tokens
  for (const entry of newEntries) {
    let { blockchain, ticker, contract_address } = entry;
    console.log(`Buying new entry: ${blockchain} -> ${ticker} -> ${contract_address}`);
    
    const chainId = chainIdMapping[blockchain];
    const dexId = dexIdMapping[blockchain];
    const usdt_address = USDTMapping[blockchain];

    if (!chainId || !dexId || !usdt_address) {
      console.log(`Skipping entry due to missing mapping for blockchain: ${blockchain}`);
      continue;
    }

    const expandSwap = new ExpandSwap({
      privateKey: process.env.PRIVATE_KEY,
      walletAddress: process.env.WALLET_ADDRESS,
      xApiKey: process.env.X_API_KEY,
      spenderAddress: process.env.SPENDER_ADDRESS,
      dexId: "1307",
      chainId: "137",
    });
    contract_address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
    const buyTokenPath = ["0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"];

    try {
      // Buy new tokens
      console.log(`Buying ${ticker} with ${amountIn} USDT`);
      
      await expandSwap.executeSwap(buyTokenPath, amountIn);

      // Get the amount of new tokens received
      const priceQuote = await expandSwap.getPriceQuote(buyTokenPath, amountIn);
      const boughtAmount = priceQuote.data.amountsOut[1];
      console.log(`Bought ${boughtAmount} ${ticker}`);

      boughtTokens.push({
        expandSwap,
        ticker,
        contract_address,
        usdt_address,
        amount: boughtAmount,
        blockchain
      });

    } catch (error) {
      console.error(`Error buying ${ticker} on ${blockchain}:`, error);
    }
  }

  // Monitor prices
  const monitorPromises = boughtTokens.map(token => 
    monitorTokenPrice(token.expandSwap, [token.contract_address, token.usdt_address], token.amount)
      .then(() => token)
  );

  const tokenToSell = await Promise.race(monitorPromises);

  // Sell the token that met the condition
  await sellToken(tokenToSell.expandSwap, [tokenToSell.contract_address, tokenToSell.usdt_address], tokenToSell.amount);

  // Sell all other tokens
  for (const token of boughtTokens) {
      if (token !== tokenToSell) {
          await sellToken(token.expandSwap, [token.contract_address, token.usdt_address], token.amount);
      }
  }
}

async function monitorTokenPrice(expandSwap, tokenPath, amount, stopLossPercentage = 0.001) {
  let maxUSDTValue = 0;

  while (true) {
      try {
          console.log(`Monitoring USDT value for ${tokenPath[0]}...`);
          const priceQuote = await expandSwap.getPriceQuote(expandSwap.dexId, tokenPath, amount);
          const usdtValue = priceQuote.data.amountsOut[1];
          console.log(`Current USDT Value: ${usdtValue}`);

          if (usdtValue > maxUSDTValue) {
              maxUSDTValue = usdtValue;
              console.log(`Updated Max USDT Value: ${maxUSDTValue}`);
          }

          if (usdtValue < maxUSDTValue * (1 - stopLossPercentage)) {
              console.log(`USDT value dropped more than ${stopLossPercentage * 100}% from max. Selling...`);
              return true; // Signal to sell
          }
      } catch (error) {
          console.error("Failed to fetch the USDT value:", error);
      }

      await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

async function sellToken(expandSwap, tokenPath, amount) {
  console.log(`Selling ${tokenPath[0]}...`);
  await expandSwap.executeSwap(tokenPath, amount.toString());

  const finalQuote = await expandSwap.getPriceQuote(expandSwap.dexId, tokenPath, amount);
  const finalUSDTAmount = finalQuote.data.amountsOut[1];
  console.log(`Final USDT amount after selling ${tokenPath[0]}: ${finalUSDTAmount}`);
  return finalUSDTAmount;
}

async function main() {
  while(true){
  try {
    const newEntries = await scrape(path.join(__dirname, '../scripts/Roadmap_Scraper.py'));
    console.log('New entries:', newEntries);
    const amountIn = '1000';

    if (newEntries.length > 0) {
      processNewEntries(newEntries, amountIn)
      .then(() => console.log("All operations completed"))
      .catch(error => console.error("An error occurred:", error));
    } else {
      console.log('No new entries found.');
    }
  } catch (error) {
    console.error('Error:', error);
  }
  await setTimeoutPromise(POLLING_INTERVAL);
}
}

main();
