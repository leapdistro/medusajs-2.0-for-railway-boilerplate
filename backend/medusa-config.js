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
      cookieSecret: COOKIE_SECRET,
      /* Extend the global JWT TTL from Medusa's default 15-minute
       * reset-password window to 24 hours. The buyer-facing pain was
       * "I opened the welcome / reset email a couple hours later and
       * the link said expired." 24h lets buyers come back to it the
       * next day; tradeoff is a longer window in which a leaked email
       * (compromised inbox, shared laptop, forwarded message) lets
       * someone else set the password. Acceptable for B2B-only signups
       * where the operator already vetted the account.
       *
       * Also bumps the Medusa session JWT from the default 1d to 24h
       * (same value — no functional change for the login session;
       * the NextAuth-side TTL mismatch handler still validates every
       * 5 min via the jwt callback and strips on 401). */
      jwtExpiresIn: "24h"
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
    /* Vite build override — bumps the admin's client-side image upload
     * ceiling from the default 1 MB to 15 MB. Without this, the admin
     * UI rejects the file in the browser before it ever reaches the
     * server (where our compressUploadsMiddleware would have shrunk
     * it). 15 MB lets full-resolution phone photos (typically 8–12 MB)
     * through; the server-side sharp pipeline then normalises to
     * ~200 KB JPEG. Mirrors the bodyParser sizeLimit on /admin/uploads
     * so the client + server share the same inbound ceiling. */
    vite: (config) => {
      config.define = {
        ...(config.define ?? {}),
        __MAX_UPLOAD_FILE_SIZE__: JSON.stringify(15 * 1024 * 1024),
      }
      return config
    },
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
    /* Fulfillment module — manual provider (Local Pickup, flat rates)
     * plus our flat-rate-per-variant provider. Module file is still
     * named `shipstation-fulfillment` for git history; the runtime
     * logic is pure rate-sum math (no ShipStation API calls). Container
     * key resolves to `fp_shipstation_shipstation`. Unconditional —
     * the provider has no env-var dependencies anymore. */
    {
      key: Modules.FULFILLMENT,
      resolve: '@medusajs/fulfillment',
      options: {
        providers: [
          { resolve: '@medusajs/fulfillment-manual',     id: 'manual' },
          { resolve: './src/modules/shipstation-fulfillment', id: 'shipstation' },
        ],
      },
    },

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
