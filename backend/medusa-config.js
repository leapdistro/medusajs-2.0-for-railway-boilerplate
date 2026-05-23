import { loadEnv, Modules, defineConfig } from '@medusajs/utils';
import {
  ADMIN_CORS,
  AUTH_CORS,
  BACKEND_URL,
  COOKIE_SECRET,
  DATABASE_URL,
  JWT_SECRET,
  REDIS_URL,
  RESEND_API_KEY,
  RESEND_FROM_EMAIL,
  SENDGRID_API_KEY,
  SENDGRID_FROM_EMAIL,
  SHOULD_DISABLE_ADMIN,
  STORE_CORS,
  STRIPE_API_KEY,
  STRIPE_WEBHOOK_SECRET,
  WORKER_MODE,
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
  MINIO_BUCKET,
  MEILISEARCH_HOST,
  MEILISEARCH_ADMIN_KEY
} from 'lib/constants';

loadEnv(process.env.NODE_ENV, process.cwd());

const medusaConfig = {
  projectConfig: {
    databaseUrl: DATABASE_URL,
    databaseLogging: false,
    redisUrl: REDIS_URL,
    workerMode: WORKER_MODE,
    http: {
      adminCors: ADMIN_CORS,
      authCors: AUTH_CORS,
      storeCors: STORE_CORS,
      jwtSecret: JWT_SECRET,
      cookieSecret: COOKIE_SECRET
    },
    build: {
      rollupOptions: {
        external: ["@medusajs/dashboard", "@medusajs/admin-shared"]
      }
    }
  },
  admin: {
    backendUrl: BACKEND_URL,
    disable: SHOULD_DISABLE_ADMIN,
  },
  modules: [
    {
      resolve: './src/modules/mbs-attributes',
    },
    {
      resolve: './src/modules/mbs-settings',
    },
    {
      resolve: './src/modules/receiving-drafts',
    },
    {
      resolve: './src/modules/receiving-history',
    },
    {
      resolve: './src/modules/qbo-connection',
    },
    {
      key: Modules.FILE,
      resolve: '@medusajs/file',
      options: {
        providers: [
          ...(MINIO_ENDPOINT && MINIO_ACCESS_KEY && MINIO_SECRET_KEY ? [{
            resolve: './src/modules/minio-file',
            id: 'minio',
            options: {
              endPoint: MINIO_ENDPOINT,
              accessKey: MINIO_ACCESS_KEY,
              secretKey: MINIO_SECRET_KEY,
              bucket: MINIO_BUCKET // Optional, default: medusa-media
            }
          }] : [{
            resolve: '@medusajs/file-local',
            id: 'local',
            options: {
              upload_dir: 'static',
              backend_url: `${BACKEND_URL}/static`
            }
          }])
        ]
      }
    },
    ...(REDIS_URL ? [{
      key: Modules.EVENT_BUS,
      resolve: '@medusajs/event-bus-redis',
      options: {
        redisUrl: REDIS_URL
      }
    },
    {
      key: Modules.WORKFLOW_ENGINE,
      resolve: '@medusajs/workflow-engine-redis',
      options: {
        redis: {
          url: REDIS_URL,
        }
      }
    }] : []),
    ...(SENDGRID_API_KEY && SENDGRID_FROM_EMAIL || RESEND_API_KEY && RESEND_FROM_EMAIL ? [{
      key: Modules.NOTIFICATION,
      resolve: '@medusajs/notification',
      options: {
        providers: [
          ...(SENDGRID_API_KEY && SENDGRID_FROM_EMAIL ? [{
            resolve: '@medusajs/notification-sendgrid',
            id: 'sendgrid',
            options: {
              channels: ['email'],
              api_key: SENDGRID_API_KEY,
              from: SENDGRID_FROM_EMAIL,
            }
          }] : []),
          ...(RESEND_API_KEY && RESEND_FROM_EMAIL ? [{
            resolve: './src/modules/email-notifications',
            id: 'resend',
            options: {
              channels: ['email'],
              api_key: RESEND_API_KEY,
              from: RESEND_FROM_EMAIL,
            },
          }] : []),
        ]
      }
    }] : []),
    /* Fulfillment module — registers the seeded manual provider (so the
     * existing static options like Local Pickup keep working) plus
     * ShipStation's live-rates provider when API creds are configured.
     * The manual provider is always included; ShipStation is opt-in. */
    ...(process.env.SHIPSTATION_API_KEY && process.env.SHIPSTATION_API_SECRET ? [{
      key: Modules.FULFILLMENT,
      resolve: '@medusajs/fulfillment',
      options: {
        providers: [
          {
            resolve: '@medusajs/fulfillment-manual',
            id: 'manual',
          },
          {
            resolve: './src/modules/shipstation-fulfillment',
            /* No `id:` field — Medusa builds the fulfillment container
             * key as `fp_${identifier}${id ? `_${id}` : ""}`. Omitting
             * yields `fp_shipstation`. seed-shipstation-options.ts uses
             * provider_id "shipstation" (Medusa prepends the `fp_`
             * itself when resolving). */
          },
        ],
      },
    }] : []),

    /* Payment module — registers all configured external providers
     * (KAJA / Authorize.net, optionally Stripe). pp_system_default is
     * always available out of the box; no need to list it here. */
    ...((process.env.KAJA_API_LOGIN_ID && process.env.KAJA_TRANSACTION_KEY)
        || (STRIPE_API_KEY && STRIPE_WEBHOOK_SECRET) ? [{
      key: Modules.PAYMENT,
      resolve: '@medusajs/payment',
      options: {
        providers: [
          ...(process.env.KAJA_API_LOGIN_ID && process.env.KAJA_TRANSACTION_KEY ? [{
            resolve: './src/modules/kaja-authnet',
            /* No `id:` field — Medusa builds the container key as
             * `pp_${identifier}${id ? `_${id}` : ""}`. Setting id here
             * would yield `pp_kaja-authnet_kaja-authnet`. Omitting it
             * leaves the clean `pp_kaja-authnet` key. Provider's
             * static identifier in service.ts is the only id source. */
            options: {
              /* Reserved for future auth_only mode. Default is one-step
               * authCaptureTransaction (money moves on Pay click). */
              captureMode: process.env.KAJA_CAPTURE_MODE || 'auth_capture',
            },
          }] : []),
          ...(STRIPE_API_KEY && STRIPE_WEBHOOK_SECRET ? [{
            resolve: '@medusajs/payment-stripe',
            id: 'stripe',
            options: {
              apiKey: STRIPE_API_KEY,
              webhookSecret: STRIPE_WEBHOOK_SECRET,
            },
          }] : []),
        ],
      },
    }] : [])
  ],
  plugins: [
  ...(MEILISEARCH_HOST && MEILISEARCH_ADMIN_KEY ? [{
      resolve: '@rokmohar/medusa-plugin-meilisearch',
      options: {
        config: {
          host: MEILISEARCH_HOST,
          apiKey: MEILISEARCH_ADMIN_KEY
        },
        settings: {
          products: {
            type: 'products',
            enabled: true,
            fields: ['id', 'title', 'description', 'handle', 'variant_sku', 'thumbnail'],
            indexSettings: {
              searchableAttributes: ['title', 'description', 'variant_sku'],
              displayedAttributes: ['id', 'handle', 'title', 'description', 'variant_sku', 'thumbnail'],
              filterableAttributes: ['id', 'handle'],
            },
            primaryKey: 'id',
          }
        }
      }
    }] : [])
  ]
};

console.log(JSON.stringify(medusaConfig, null, 2));
export default defineConfig(medusaConfig);
