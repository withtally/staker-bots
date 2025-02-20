import axios, { AxiosInstance } from 'axios';
import { BigNumberish, ethers } from 'ethers';
import { IPriceFeed, PriceFeedConfig, TokenPrice } from '../interfaces';
import { Logger } from '@/monitor/logging';

interface CoinMarketCapQuote {
  USD: {
    price: number;
    last_updated: string;
  };
}

interface CoinMarketCapResponse {
  data: {
    [address: string]: {
      quote: CoinMarketCapQuote;
    };
  };
}

export class CoinMarketCapFeed implements IPriceFeed {
  private readonly client: AxiosInstance;
  private readonly logger: Logger;
  private readonly cache: Map<string, TokenPrice>;
  private readonly cacheDuration: number = 10 * 60 * 1000; // 10 minutes cache

  constructor(config: PriceFeedConfig, logger: Logger) {
    this.client = axios.create({
      baseURL: config.baseUrl || 'https://pro-api.coinmarketcap.com/v2',
      timeout: config.timeout || 5000,
      headers: {
        'X-CMC_PRO_API_KEY': config.apiKey,
      },
    });
    this.logger = logger;
    this.cache = new Map();
  }

  async getTokenPrice(tokenAddress: string): Promise<TokenPrice> {
    const cachedPrice = this.cache.get(tokenAddress);
    if (
      cachedPrice &&
      Date.now() - cachedPrice.lastUpdated.getTime() < this.cacheDuration
    ) {
      return cachedPrice;
    }

    try {
      const response = await this.client.get<CoinMarketCapResponse>(
        '/cryptocurrency/quotes/latest',
        {
          params: {
            address: tokenAddress,
            convert: 'USD',
          },
        },
      );

      const tokenData = response.data.data[tokenAddress.toLowerCase()];
      if (!tokenData?.quote?.USD) {
        throw new Error(`No price data available for token ${tokenAddress}`);
      }

      const price = tokenData.quote.USD.price;
      const lastUpdated = new Date(tokenData.quote.USD.last_updated);

      const tokenPrice: TokenPrice = {
        usd: price,
        lastUpdated,
      };

      this.cache.set(tokenAddress, tokenPrice);
      return tokenPrice;
    } catch (error) {
      this.logger.error('Failed to fetch token price from CoinMarketCap', {
        error,
        tokenAddress,
      });
      throw error;
    }
  }

  async getTokenPriceInWei(
    tokenAddress: string,
    amount: BigNumberish,
  ): Promise<bigint> {
    const price = await this.getTokenPrice(tokenAddress);
    const amountInWei = ethers.parseEther(amount.toString());
    const priceInWei = ethers.parseEther(price.usd.toString());
    return (amountInWei * priceInWei) / ethers.parseEther('1');
  }
}
