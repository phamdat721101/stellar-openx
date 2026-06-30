import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    openapi: '3.0.3',
    info: {
      title: 'OpenX-S API',
      version: '3.0.0',
      description:
        'Stellar-native AI assistant marketplace. Payment rail: x402-on-Stellar (USDC). Optional Privacy Pool premium tier.',
      'x-network': process.env.STELLAR_NETWORK ?? 'testnet',
      'x-payment-modes': ['public', 'private'],
    },
    servers: [
      { url: process.env.API_PUBLIC_URL ?? 'http://localhost:3001', description: 'Stellar testnet' },
    ],
    paths: {
      '/v3/agents': {
        get: { summary: 'List published agents', responses: { 200: { description: 'OK' } } },
      },
      '/v3/discover': {
        post: { summary: 'Concierge ranking', responses: { 200: { description: 'OK' } } },
      },
      '/v3/marketplace/listings': {
        get: { summary: 'Catalog browse (paginated)', responses: { 200: { description: 'OK' } } },
      },
      '/v3/marketplace/seller/publish': {
        post: { summary: 'Publish agent (Stellar registry + Supabase mirror)' },
      },
      '/api/v1/{slug}': {
        post: {
          summary: 'Paywalled brain endpoint (Stellar x402)',
          responses: {
            402: { description: 'Stellar payment challenge in JSON body' },
            200: { description: 'Inference result' },
          },
        },
      },
      '/api/v1/credits/buy-pack-{usd}': {
        post: { summary: 'Coinflow Stellar fiat onramp' },
      },
    },
    components: {
      securitySchemes: {
        stellarAddress: {
          type: 'apiKey',
          in: 'header',
          name: 'x-stellar-address',
          description: 'Stellar G… account id of the caller',
        },
      },
    },
  });
});

export default router;
