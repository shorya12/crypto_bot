const { Wallet, prepareTransaction } = require('expand-network');
const axios = require('axios');

/**
 * ExpandSwap class handles the execution of token swaps using the Expand network.
 * 
 * The class provides methods to:
 * - Retrieve price quotes for token swaps.
 * - Approve tokens for swapping.
 * - Prepare swap transactions.
 * - Execute swap transactions.
 * 
 * Constructor parameters:
 * @param {Object} config - Configuration object containing necessary parameters.
 * @param {string} config.privateKey - The private key of the wallet.
 * @param {string} config.walletAddress - The public address of the wallet.
 * @param {string} config.xApiKey - API key for accessing the expand.network services.
 * @param {string} config.spenderAddress - Address of the Uniswap V3 SwapRouter02.
 * @param {string} config.dexId - DEX ID for the network.
 * @param {string} config.chainId - Chain ID for the network.
 */
class ExpandSwap {
    constructor({ privateKey, walletAddress, xApiKey, spenderAddress, dexId, chainId }) {
        this.privateKey = privateKey;
        this.walletAddress = walletAddress;
        this.xApiKey = xApiKey;
        this.spenderAddress = spenderAddress;
        this.dexId = dexId;
        this.chainId = chainId;
        this.wallet = new Wallet({ privateKey: privateKey, xApiKey: xApiKey });
    }
    
    /**
     * Retrieves a price quote for a token swap.
     * @param {string} dexId - The ID of the decentralized exchange (DEX).
     * @param {string[]} path - The swap path (e.g., from WETH to USDT).
     * @param {string} amountIn - The amount of the input token.
     * @returns {Promise<Object>} - The price quote data.
     */
    async getPriceQuote(dexId, path, amountIn) {
        try {
            const response = await axios.get('https://api.expand.network/dex/getprice', {
                params: {
                    dexId: dexId,
                    path: path.join(','),
                    amountIn: amountIn,
                },
                headers: {
                    'x-api-key': this.xApiKey,
                },
            });
            // const amountsOut = response.data.data.amountsOut;

            // console.log("Price info", response.data);
            // console.log("AmountsOut", amountsOut);
            return response.data;
        } catch (error) {
            console.error('Error fetching price quote:', error);
            throw error;
        }
    }

    /**
     * Approves tokens for swapping.
     * @param {string} amountIn - The amount of tokens to approve.
     * @param {string} tokenAddress - The address of the token to approve.
     * @returns {Promise<Object>} - The approval transaction receipt.
     */
    async approveToken(amountIn, tokenAddress) {
        try {
            const approvedTx = await prepareTransaction('https://api.expand.network/fungibletoken/approve', {
                from: this.walletAddress,
                tokenAddress: tokenAddress,
                amount: amountIn,
                to: this.spenderAddress,
                gas: '229880',
                chainId: this.chainId,
                xApiKey: this.xApiKey,
            });

            if (approvedTx?.response?.data?.status === 400) {
                console.log('Error in preparing the transaction:', approvedTx.response.data);
                return;
            }

            const signedApproveTx = await this.wallet.signTransaction(approvedTx);
            console.log('Signed approval transaction:', signedApproveTx);

            const approveReceipt = await this.wallet.sendTransaction({
                chainId: signedApproveTx.chainId,
                rawTransaction: signedApproveTx.rawTransaction,
            });

            if (approveReceipt?.response?.data?.status === 400) {
                console.log('Error in sending the transaction:', approveReceipt.response.data);
                return;
            }

            console.log('Approval transaction pending....', approveReceipt);
            return approveReceipt;
        } catch (error) {
            console.error('Error during token approval:', error);
            throw error;
        }
    }

    /**
     * Prepares a swap transaction.
     * @param {string} amountIn - The amount of tokens to swap.
     * @param {string[]} tokenAddresses - The swap path addresses.
     * @returns {Promise<Object>} - The prepared swap transaction.
     */
    async prepareSwapTransaction(amountIn, tokenAddresses) {
        try {
            const preparedSwapTx = await prepareTransaction('https://api.expand.network/dex/swap', {
                dexId: this.dexId,
                amountIn: amountIn,
                amountOutMin: '0',
                path: tokenAddresses,
                to: this.walletAddress,
                poolFees: '3000',
                from: this.walletAddress,
                gas: '229880',
                xApiKey: this.xApiKey,
            });

            console.log('Prepared swap transaction:', preparedSwapTx);
            return preparedSwapTx;
        } catch (error) {
            console.error('Error preparing swap transaction:', error);
            throw error;
        }
    }

    /**
     * Executes a swap transaction.
     * @param {string[]} tokenPath - The swap path (e.g., from WETH to USDT).
     * @param {string} amountIn - The amount of the input token.
     * @returns {Promise<void>}
     */
    async executeSwap(tokenPath, amountIn) {
        try {
            await this.approveToken(amountIn, tokenPath[0]);

            const quote = await this.getPriceQuote(this.dexId, tokenPath, amountIn);
            console.log('Price quote:', quote);

            const preparedSwapTx = await this.prepareSwapTransaction(amountIn, tokenPath);
            const signedSwapTx = await this.wallet.signTransaction(preparedSwapTx);
            console.log('Signed swap transaction:', signedSwapTx);

            const swapReceipt = await this.wallet.sendTransaction({
                chainId: signedSwapTx.chainId,
                rawTransaction: signedSwapTx.rawTransaction,
            });

            if (swapReceipt?.response?.data?.status === 400) {
                console.log('Error in sending the transaction:', swapReceipt.response.data);
                return;
            }

            console.log('Swap transaction complete....', swapReceipt.data);
        } catch (error) {
            console.error('Failed to fetch price quote or prepare transaction:', error);
            if (error.response) {
                console.error('Error response:', error.response.data);
            }
            throw error;
        }
    }
}

module.exports = ExpandSwap;
